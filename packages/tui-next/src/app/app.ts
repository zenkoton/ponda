/**
 * PondaTui 门面：opencode 范式的装配层。
 * start() 建立 Screen（帧循环 = 根 effect + 差分写出），输入经键位层路由，
 * 数据层轮询/通知在 batch 内更新信号；组件树读信号自动重渲染（无 requestRender）。
 */

import type { RpcClient } from "../../../rpc/src/client.ts";
import { Methods } from "../../../rpc/src/protocol.ts";
import { Screen } from "../screen.ts";
import { batch } from "../signal.ts";
import type { Terminal } from "../terminal.ts";
import { App } from "./components.ts";
import { createDataLayer, type DataLayer } from "./data.ts";
import type { MergeConfirmState } from "./dialogs.ts";
import { createInputDispatcher, type InputDeps } from "./keybinds.ts";
import { createTuiState, type TuiState } from "./state.ts";

export interface PondaTuiOptions {
	env: string;
	home: string;
	client: RpcClient;
	terminal: Terminal;
	pollMs?: number;
	onFrame?: (lines: string[]) => void;
	onStopped?: () => void;
}

export class PondaTui {
	readonly state: TuiState;
	private readonly opts: PondaTuiOptions;
	private readonly data: DataLayer;
	private readonly dispatchInput: (data: string) => void;
	private screen: Screen | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private spinnerTimer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private mergeCallbacks: { onApply: () => void; onDiscard: () => void } | null = null;

	constructor(opts: PondaTuiOptions) {
		this.opts = opts;
		this.state = createTuiState(opts.env);
		this.data = createDataLayer({ state: this.state, client: opts.client, home: opts.home });
		this.dispatchInput = createInputDispatcher(this.state, this.inputDeps());
	}

	/** 兼容测试的活视图（属性读取时求值信号） */
	get model() {
		const s = this.state;
		return {
			get sessions() {
				return s.sessions();
			},
			get currentId() {
				return s.currentId();
			},
			get activeTabId() {
				return s.activeTabId();
			},
			get leftTab() {
				return s.leftTab();
			},
			get tabs() {
				return s.tabs();
			},
			get swarm() {
				return s.swarm();
			},
		};
	}

	get editor(): TuiState["editor"] {
		return this.state.editor;
	}

	async start(preferredSessionId?: string): Promise<void> {
		await this.data.refresh();
		// 只自动 attach 到 live 会话（ended 是只读历史，发送会失败）；
		// 没有 live 会话时留空，首条消息自动建新会话（opencode 式流程）
		const target =
			(preferredSessionId !== undefined &&
			this.state.sessions().some((s) => s.sessionId === preferredSessionId && s.status !== "ended")
				? preferredSessionId
				: null) ??
			this.state.sessions().find((s) => s.status === "running" || s.status === "detached")?.sessionId ??
			null;
		if (target !== null) {
			await this.attach(target, 0);
		}

		this.opts.client.setNotificationHandler((n) => this.data.onNotification(n));

		// 帧循环：根 effect 读组件树依赖的信号，变化即整帧重算 + 差分写出
		this.screen = new Screen({
			terminal: this.opts.terminal,
			root: () => App(this.state),
			onFrame: this.opts.onFrame,
			onInput: (data) => this.handleInput(data),
		});
		this.screen.start();
		this.running = true;
		this.pollTimer = setInterval(() => {
			void this.data.refresh();
		}, this.opts.pollMs ?? 2000);
		// 生成中动画：仅当前会话 processing 时推进 tick（避免空转重渲染）
		this.spinnerTimer = setInterval(() => {
			const id = this.state.currentId();
			if (id === null) return;
			if (this.state.sessions().some((s) => s.sessionId === id && s.processing)) {
				this.state.bumpSpinner();
			}
		}, 120);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.spinnerTimer !== null) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = null;
		}
		if (this.state.currentId() !== null) {
			try {
				await this.opts.client.request(Methods.sessionDetach, { sessionId: this.state.currentId() });
			} catch {
				// daemon 不可达：后台会话由 daemon 托管
			}
		}
		this.screen?.stop();
		this.screen = null;
		this.opts.onStopped?.();
	}

	get isRunning(): boolean {
		return this.running;
	}

	handleInput(data: string): void {
		this.dispatchInput(data);
	}

	private async attach(sessionId: string, cursor: number): Promise<void> {
		const r = await this.opts.client.request<{ replay: string[] }>(Methods.sessionAttach, {
			sessionId,
			cursor,
		});
		const workspace = this.state.sessions().find((s) => s.sessionId === sessionId)?.workspace ?? null;
		// 重放整段落进一个 batch：一次渲染
		batch(() => {
			this.state.setCurrentId(sessionId);
			this.state.resetEntries();
			for (const line of r.replay) this.state.appendEntryLine(line);
			this.state.setScroll(0);
			this.state.setFileTreeRoot(workspace ?? this.state.fileTree().root);
		});
		void this.data.refreshStatusLine();
	}

	/** 权限模式循环 plan→approve→full-auto（03 §7.3）；经 RPC 落 daemon 会话级状态 */
	private async cycleMode(): Promise<void> {
		const order = ["plan", "approve", "full-auto"] as const;
		const cur = this.state.statusLine().mode;
		const idx = order.indexOf(cur as (typeof order)[number]);
		const next = order[(idx + 1) % order.length] ?? "approve";
		try {
			await this.ensureSendableSession();
			const sessionId = this.state.currentId();
			if (sessionId === null) return;
			await this.opts.client.request(Methods.sessionSetMode, { sessionId, mode: next });
			this.state.setStatusLine({ ...this.state.statusLine(), mode: next });
			this.state.setHint(`mode: ${next}`);
		} catch (e) {
			this.state.setHint(e instanceof Error ? e.message.slice(0, 60) : "切换失败");
		}
	}

	/** 思考强度循环 off→low→medium→high（04 §5.4；^x ctrl+t / daemon session.set_thinking） */
	private async cycleThinking(): Promise<void> {
		const order = ["off", "low", "medium", "high"] as const;
		const cur = this.state.statusLine().thinking;
		const idx = order.indexOf(cur as (typeof order)[number]);
		const next = order[(idx + 1) % order.length] ?? "off";
		try {
			await this.ensureSendableSession();
			const sessionId = this.state.currentId();
			if (sessionId === null) return;
			await this.opts.client.request(Methods.sessionSetThinking, { sessionId, level: next });
			this.state.setStatusLine({ ...this.state.statusLine(), thinking: next });
			this.state.setHint(`think: ${next}`);
		} catch (e) {
			this.state.setHint(e instanceof Error ? e.message.slice(0, 60) : "切换失败");
		}
	}

	private inputDeps(): InputDeps {
		return {
			quit: () => {
				void this.stop();
			},
			cycleMode: () => {
				void this.cycleMode();
			},
			cycleThinking: () => {
				void this.cycleThinking();
			},
			attach: (sessionId) => {
				void this.attach(sessionId, 0);
			},
			detach: (sessionId) => {
				void this.opts.client.request(Methods.sessionDetach, { sessionId }).catch(() => {});
			},
			send: () => {
				void this.send();
			},
			confirmContract: (taskId) => {
				void this.opts.client.request(Methods.taskConfirm, { taskId }).catch(() => {});
			},
			replanContract: (taskId) => {
				void this.opts.client.request(Methods.taskReplan, { taskId }).catch(() => {});
			},
			approveChange: (taskId, accept) => {
				void this.opts.client.request(Methods.taskApproveChange, { taskId, accept }).catch(() => {});
			},
			respondPermission: (requestId, approved, scope) => {
				void this.opts.client.request(Methods.permissionRespond, { requestId, approved, scope }).catch(() => {});
			},
			mergeApply: () => {
				this.mergeCallbacks?.onApply();
				this.mergeCallbacks = null;
			},
			mergeDiscard: () => {
				this.mergeCallbacks?.onDiscard();
				this.mergeCallbacks = null;
			},
		};
	}

	// —— 发送（04 §5.4 / §5.5 插话）——

	private async send(): Promise<void> {
		const raw = this.state.editor.text;
		if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
			const last = this.state.editor.lines.length - 1;
			this.state.editor.lines[last] = (this.state.editor.lines[last] ?? "").slice(0, -1);
			this.state.editor.newline();
			this.state.editor.end();
			this.state.bumpEditor();
			return;
		}
		const text = raw.trim();
		this.state.editor.clear();
		this.state.setCompletion(null);
		this.state.bumpEditor();
		if (text.length === 0) return;
		if (await this.runSlashCommand(text)) return;
		try {
			this.state.setHint("");
			const cellId = this.state.swarm().selectedCellId;
			if (cellId !== null) {
				// 插话：向该 cell 信箱发消息（04 §5.5 / 05 §6.3）
				await this.opts.client.request(Methods.swarmSend, {
					from: "main",
					to: cellId,
					payload: text,
				});
				this.state.setHint(`→ ${cellId.slice(0, 12)} 信箱`);
				return;
			}
			// 无会话 / 当前会话只读（ended 历史）→ 自动开新会话再发（opencode 式流程）
			await this.ensureSendableSession();
			if (this.state.currentId() === null) return;
			await this.opts.client.request(Methods.sessionSend, {
				sessionId: this.state.currentId(),
				text,
			});
		} catch (e) {
			this.state.setHint(e instanceof Error ? e.message.slice(0, 60) : "发送失败");
		}
	}

	/** 保证当前 attach 的会话可发送：缺失或 ended/interrupted 时新建（workspace = cwd） */
	private async ensureSendableSession(): Promise<void> {
		const id = this.state.currentId();
		if (id !== null) {
			const row = this.state.sessions().find((s) => s.sessionId === id);
			if (row === undefined || row.status === "running" || row.status === "detached") return;
			// 只读历史会话：切到新会话（旧会话仍可从侧栏查看）
			this.state.setHint("历史会话只读，已开新会话");
		}
		const created = await this.opts.client.request<{ sessionId: string }>(Methods.sessionNew, {
			workspace: process.cwd(),
		});
		await this.attach(created.sessionId, 0);
		await this.data.refresh();
	}

	// —— 斜杠命令（04 §5.4：/ 命令补全项与执行面保持一致） ——

	private static readonly SLASH_HELP = [
		"ponda 命令：",
		"  /help                    本帮助",
		"  /new                     新建会话并切换",
		"  /sessions                打开会话侧栏",
		"  /mode <plan|approve|full-auto>  切换权限模式（03 §7.3）",
		"  /goal <目标描述>          启动 goal 任务（成果契约确认弹窗随后出现）",
		"  /wiki-rebuild            重建当前工作区 .wiki 知识库",
		"  /undo                    撤销最近一轮修改（回到上一快照/baseline）",
		"  /end                     结束当前会话（转只读；后台任务不受影响）",
		"键位：Esc 导航模式（j/k 滚动、t 侧栏、[/] 标签页、Tab 下一会话、p 权限模式）；Ctrl-X 前缀键（^x p 切模式、^x ctrl+t 切思考强度）。",
	].join("\n");

	/** 本地通知：以 assistant 条目形式进对话流（不落盘，仅本 UI） */
	private appendLocalNotice(text: string): void {
		this.state.appendEntryLine(
			JSON.stringify({
				type: "message",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", content: [{ type: "text", text }] },
			}),
		);
	}

	/** 处理 / 命令；返回 false 表示不是命令（走正常发送） */
	private async runSlashCommand(text: string): Promise<boolean> {
		if (!text.startsWith("/")) return false;
		const space = text.indexOf(" ");
		const cmd = space === -1 ? text : text.slice(0, space);
		const arg = space === -1 ? "" : text.slice(space + 1).trim();
		try {
			switch (cmd) {
				case "/help":
					this.appendLocalNotice(PondaTui.SLASH_HELP);
					return true;
				case "/new": {
					const created = await this.opts.client.request<{ sessionId: string }>(Methods.sessionNew, {
						workspace: process.cwd(),
					});
					await this.attach(created.sessionId, 0);
					await this.data.refresh();
					this.state.setHint("已新建会话");
					return true;
				}
				case "/sessions":
					this.state.showSidebar("sessions");
					return true;
				case "/end": {
					// 结束当前会话（PM 易用性 #10；ended 会话转只读，后台任务不受影响）
					const sessionId = this.state.currentId();
					if (sessionId === null) {
						this.appendLocalNotice("当前无会话");
						return true;
					}
					await this.opts.client.request(Methods.sessionEnd, { sessionId });
					this.state.setHint("会话已结束（只读）");
					await this.data.refresh();
					return true;
				}
				case "/undo": {
					// TUI 内撤销入口（PM 对标项）：基于快照链回滚最近一轮（03 §6.2）
					await this.ensureSendableSession();
					const sessionId = this.state.currentId();
					if (sessionId === null) return true;
					const st = await this.opts.client.request<{
						activity: { turns: number; baseline: string | null } | null;
						changes: { path: string; status: string }[];
					}>(Methods.sandboxStatus, { sessionId });
					if (st.activity === null) {
						this.appendLocalNotice("无快照链（本会话尚未产生可撤销的修改）");
						return true;
					}
					const target = st.activity.turns <= 1 ? { baseline: true as const } : { turn: st.activity.turns - 1 };
					const label = "baseline" in target ? "baseline" : `turn ${target.turn}`;
					this.openMergeConfirm(
						st.changes.map((c) => ({ path: c.path, status: c.status })),
						`撤销最近一轮修改，回到 ${label}？（reset --hard，未提交变更将丢失）`,
						{
							onApply: () => {
								void this.opts.client
									.request(Methods.sandboxRollback, { sessionId, ...target })
									.then(() => {
										this.state.setHint(`已回滚到 ${label}`);
										this.appendLocalNotice(`已撤销最近一轮修改（回到 ${label}，快照链保留）`);
									})
									.catch((e: unknown) => {
										this.state.setHint(e instanceof Error ? e.message.slice(0, 60) : "回滚失败");
									});
							},
							onDiscard: () => {
								this.state.setHint("已取消撤销");
							},
						},
					);
					return true;
				}
				case "/mode": {
					if (arg !== "plan" && arg !== "approve" && arg !== "full-auto") {
						this.appendLocalNotice(
							"用法：/mode <plan|approve|full-auto>\nplan：一切写/执行需确认；approve：工作区内预授；full-auto：工作区内写与执行预授。",
						);
						return true;
					}
					await this.ensureSendableSession();
					const sessionId = this.state.currentId();
					if (sessionId === null) return true;
					await this.opts.client.request(Methods.sessionSetMode, { sessionId, mode: arg });
					this.state.setStatusLine({ ...this.state.statusLine(), mode: arg });
					this.state.setHint(`mode: ${arg}`);
					return true;
				}
				case "/goal": {
					if (arg.length === 0) {
						this.appendLocalNotice("用法：/goal <目标描述>");
						return true;
					}
					const ws = this.currentWorkspace();
					const r = await this.opts.client.request<{ taskId: string }>(Methods.taskStart, {
						goal: arg,
						workspace: ws,
					});
					this.appendLocalNotice(`goal 任务已创建：${r.taskId}\n确认成果契约后进入 executing；右栏可看成果状态。`);
					return true;
				}
				case "/wiki-rebuild": {
					const ws = this.currentWorkspace();
					const r = await this.opts.client.request<{ created: string[] }>(Methods.wikiBuild, {
						workspace: ws,
					});
					this.appendLocalNotice(
						`wiki 重建完成（${ws}）：${r.created.length} 页\n${r.created.map((p) => `- ${p}`).join("\n")}`,
					);
					return true;
				}
				default:
					this.appendLocalNotice(`未知命令：${cmd}\n输入 /help 查看可用命令。`);
					return true;
			}
		} catch (e) {
			this.state.setHint(e instanceof Error ? e.message.slice(0, 60) : "命令执行失败");
			return true;
		}
	}

	private currentWorkspace(): string {
		const id = this.state.currentId();
		const row = id !== null ? this.state.sessions().find((s) => s.sessionId === id) : undefined;
		return row?.workspace ?? process.cwd();
	}

	// —— 合并/结算确认（sandbox-guard 接入后由事件触发；公开供驱动/测试） ——

	openMergeConfirm(
		files: MergeConfirmState["files"],
		note: string,
		cb: { onApply: () => void; onDiscard: () => void },
	): void {
		this.mergeCallbacks = cb;
		this.state.setDialog({ kind: "merge", files, note });
	}
}
