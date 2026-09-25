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
	}

	private inputDeps(): InputDeps {
		return {
			quit: () => {
				void this.stop();
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
