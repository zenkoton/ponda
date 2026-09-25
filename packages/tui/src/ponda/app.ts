/**
 * PondaTui（M5 全量交互）：以 fork 内 pi-tui 的 TuiMainScreen 为渲染根
 * （差分渲染 + 同步输出），输入经 addInputListener 统一路由：
 * 弹窗 → 补全 → 输入模式（多行编辑/@//补全）→ 导航模式（页签/文件树/滚动）。
 */

import { HistoryIndex } from "../../../core/src/history.ts";
import { EnvStore } from "../../../core/src/store.ts";
import type { RpcClient } from "../../../rpc/src/client.ts";
import {
	type CostSnapshot,
	Methods,
	Notifications,
	type RpcNotification,
	type SessionListItem,
	type SwarmStatus,
	type TaskInfo,
} from "../../../rpc/src/protocol.ts";
import type { Terminal } from "../terminal.ts";
import type { Component } from "../tui.ts";
import { TuiMainScreen } from "../tui-main-screen.ts";
import { type CompletionState, computeCompletion } from "./completion.ts";
import type { DialogState, MergeConfirmState } from "./dialogs.ts";
import { PondaEditor } from "./editor.ts";
import { type FileTreeState, listFileCandidates, newFileTreeState, scanTree } from "./files.ts";
import {
	applyCostSnapshot,
	applySessionList,
	closeTab,
	cycleTab,
	newReadModel,
	openFileTab,
	pickNextSession,
	pushEntryLine,
	type ReadModel,
	resetEntries,
	taskSummaryOf,
} from "./model.ts";
import { renderFrame } from "./view.ts";

export interface PondaTuiOptions {
	env: string;
	home: string;
	client: RpcClient;
	terminal: Terminal;
	pollMs?: number;
	onFrame?: (lines: string[]) => void;
	onStopped?: () => void;
}

class MainView implements Component {
	private readonly app: PondaTui;

	constructor(app: PondaTui) {
		this.app = app;
	}
	render(width: number): string[] {
		return this.app.renderFrame(width);
	}
	invalidate(): void {}
}

export class PondaTui {
	readonly model: ReadModel;
	readonly editor = new PondaEditor();
	completion: CompletionState | null = null;
	dialog: DialogState = null;
	readonly fileTree: FileTreeState = newFileTreeState();
	hint = "";

	private screen: TuiMainScreen | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private mergeCallbacks: { onApply: () => void; onDiscard: () => void } | null = null;
	/** 已弹过契约/变更确认的任务标记（避免重复弹窗） */
	private contractPromptedFor = new Set<string>();
	private changePromptedFor = new Set<string>();
	private readonly opts: PondaTuiOptions;

	constructor(opts: PondaTuiOptions) {
		this.opts = opts;
		this.model = newReadModel(opts.env);
	}

	async start(preferredSessionId?: string): Promise<void> {
		await this.refresh();
		const target =
			(preferredSessionId !== undefined && this.model.sessions.some((s) => s.sessionId === preferredSessionId)
				? preferredSessionId
				: null) ??
			this.model.sessions.find((s) => s.status === "running" || s.status === "detached")?.sessionId ??
			this.model.sessions[0]?.sessionId ??
			null;
		if (target !== null) {
			await this.attach(target, 0);
		}

		this.opts.client.setNotificationHandler((n: RpcNotification) => this.onNotification(n));

		// 差分渲染根（fork 内 pi-tui 渲染循环）
		this.screen = new TuiMainScreen(this.opts.terminal);
		this.screen.addChild(new MainView(this));
		this.screen.addInputListener((data: string) => {
			this.handleInput(data);
			return undefined;
		});
		this.screen.start();
		this.running = true;
		this.pollTimer = setInterval(() => {
			void this.refresh().then(() => this.requestRender());
		}, this.opts.pollMs ?? 2000);
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.model.currentId !== null) {
			try {
				await this.opts.client.request(Methods.sessionDetach, { sessionId: this.model.currentId });
			} catch {
				// daemon 不可达：后台会话由 daemon 托管
			}
		}
		this.screen?.stop();
		this.opts.terminal.stop();
		this.opts.onStopped?.();
	}

	get isRunning(): boolean {
		return this.running;
	}

	requestRender(): void {
		this.screen?.requestRender();
	}

	renderFrame(width: number): string[] {
		const lines = renderFrame(
			{
				model: this.model,
				input: { editor: this.editor, completion: this.completion, hint: this.hint },
				dialog: this.dialog,
				fileTree: this.fileTree,
			},
			width,
			this.opts.terminal.rows,
		);
		this.opts.onFrame?.(lines);
		return lines;
	}

	// —— 数据 ——

	private async refresh(): Promise<void> {
		const list = await this.opts.client.request<SessionListItem[]>(Methods.sessionList);
		applySessionList(this.model, list);
		try {
			const history = new HistoryIndex(new EnvStore(this.opts.home)).list({ env: this.opts.env });
			const known = new Set(this.model.sessions.map((s) => s.sessionId));
			for (const h of history) {
				if (known.has(h.sessionId)) continue;
				this.model.sessions.push({
					sessionId: h.sessionId,
					workspace: h.workspace,
					status: "ended",
					processing: false,
					attached: 0,
					tokens: h.tokens,
					costUsd: h.cost,
				});
			}
		} catch {
			// history 扫描失败不阻塞
		}
		const snap = await this.opts.client.request<CostSnapshot>(Methods.costSnapshot);
		applyCostSnapshot(this.model, snap);
		await this.refreshTask();
		await this.refreshSwarm();
		this.syncFileTreeRoot();
	}

	/** 拉取 swarm 状态（子 agent 切换条，04 §5.5） */
	private async refreshSwarm(): Promise<void> {
		const st = await this.opts.client.request<SwarmStatus>(Methods.swarmStatus);
		this.model.swarm.cells = st.cells;
		if (this.model.swarm.mainSessionId === null && this.model.currentId !== null) {
			this.model.swarm.mainSessionId = this.model.currentId;
		}
	}

	/** 拉取 goal 任务（右栏成果状态 + 契约确认/变更审批弹窗触发） */
	private async refreshTask(): Promise<void> {
		const r = await this.opts.client.request<{ tasks: TaskInfo[] }>(Methods.taskStatus);
		const active = r.tasks.find((t) => t.phase !== "closed" && t.phase !== "cancelled") ?? null;
		this.model.task = active !== null ? taskSummaryOf(active) : null;
		if (active === null || this.dialog !== null) return;
		if (active.pendingChanges !== null && active.pendingChanges.length > 0) {
			const key = `${active.taskId}:r${active.contractRevision}`;
			if (!this.changePromptedFor.has(key)) {
				this.changePromptedFor.add(key);
				this.dialog = {
					kind: "change",
					taskId: active.taskId,
					contractRevision: active.contractRevision,
					changes: active.pendingChanges.map((c) => ({
						op: c.op,
						id: c.deliverable.id,
						name: c.deliverable.name,
						reason: c.reason,
					})),
				};
			}
			return;
		}
		if (active.phase === "planning" && !this.contractPromptedFor.has(active.taskId)) {
			this.contractPromptedFor.add(active.taskId);
			this.dialog = {
				kind: "contract",
				taskId: active.taskId,
				goal: active.goal,
				replans: active.replans,
				deliverables: active.deliverables.map((d) => ({
					id: d.id,
					name: d.name,
					doneCriteria: d.doneCriteria,
					verifyType: d.verify.type,
				})),
			};
		}
	}

	private syncFileTreeRoot(): void {
		const cur = this.model.sessions.find((s) => s.sessionId === this.model.currentId);
		this.fileTree.root = cur?.workspace ?? this.fileTree.root;
	}

	private async attach(sessionId: string, cursor: number): Promise<void> {
		const r = await this.opts.client.request<{ replay: string[] }>(Methods.sessionAttach, { sessionId, cursor });
		this.model.currentId = sessionId;
		resetEntries(this.model);
		for (const line of r.replay) pushEntryLine(this.model, line);
		this.syncFileTreeRoot();
		this.requestRender();
	}

	private onNotification(n: RpcNotification): void {
		if (n.method === Notifications.taskEvents) {
			void this.refreshTask().then(() => this.requestRender());
			return;
		}
		if (n.method === Notifications.swarmEvents) {
			void this.refreshSwarm().then(() => this.requestRender());
			return;
		}
		if (n.method === Notifications.permissionRequest) {
			const req = (
				n.params as {
					request: { requestId: string; privilege: string; reason: string; detail: Record<string, string> };
				}
			).request;
			this.dialog = {
				kind: "permission",
				requestId: req.requestId,
				privilege: req.privilege,
				reason: req.reason,
				detail: {
					tool: String(req.detail.tool ?? ""),
					targetPath: req.detail.targetPath,
					command: req.detail.command,
					mode: String(req.detail.mode ?? ""),
				},
			};
			this.requestRender();
			return;
		}
		if (n.method !== Notifications.sessionEvents) return;
		const p = n.params as { sessionId: string; event: { kind: string; line?: string; status?: string } };
		if (p.sessionId !== this.model.currentId) return;
		if (p.event.kind === "entry" && typeof p.event.line === "string") {
			pushEntryLine(this.model, p.event.line);
		} else if (p.event.kind === "status" && typeof p.event.status === "string") {
			const row = this.model.sessions.find((s) => s.sessionId === p.sessionId);
			if (row !== undefined && (p.event.status === "live" || p.event.status === "ended")) {
				row.status = p.event.status === "live" ? (row.attached > 0 ? "running" : "detached") : "ended";
			}
		}
		this.requestRender();
	}

	// —— 输入路由 ——

	handleInput(data: string): void {
		if (this.dialog !== null) {
			this.handleDialogInput(data);
			return;
		}
		if (this.model.inputMode) {
			this.handleEditorInput(data);
			return;
		}
		this.handleNavInput(data);
	}

	private handleDialogInput(data: string): void {
		const d = this.dialog;
		if (d === null) return;
		if (d.kind === "contract") {
			if (data === "\r" || data === "\n") {
				this.dialog = null;
				void this.opts.client.request(Methods.taskConfirm, { taskId: d.taskId }).catch(() => {});
			} else if (data === "r") {
				this.dialog = null;
				void this.opts.client.request(Methods.taskReplan, { taskId: d.taskId }).catch(() => {});
			} else if (data === "\x1b") {
				this.dialog = null;
			} else {
				return;
			}
			this.requestRender();
			return;
		}
		if (d.kind === "change") {
			if (data === "y") {
				this.dialog = null;
				void this.opts.client
					.request(Methods.taskApproveChange, { taskId: d.taskId, accept: true })
					.catch(() => {});
			} else if (data === "n") {
				this.dialog = null;
				void this.opts.client
					.request(Methods.taskApproveChange, { taskId: d.taskId, accept: false })
					.catch(() => {});
			} else {
				return;
			}
			this.requestRender();
			return;
		}
		if (d.kind === "permission") {
			const map: Record<string, { approved: boolean; scope: "once" | "session" | "env-always" }> = {
				y: { approved: true, scope: "once" },
				s: { approved: true, scope: "session" },
				a: { approved: true, scope: "env-always" },
				n: { approved: false, scope: "once" },
			};
			const answer = map[data];
			if (answer === undefined) return;
			this.dialog = null;
			void this.opts.client
				.request(Methods.permissionRespond, { requestId: d.requestId, ...answer })
				.catch(() => {});
			this.requestRender();
			return;
		}
		if (data === "\r" || data === "\n") {
			this.dialog = null;
			this.mergeCallbacks?.onApply();
			this.mergeCallbacks = null;
			this.requestRender();
		} else if (data === "d") {
			this.dialog = null;
			this.mergeCallbacks?.onDiscard();
			this.mergeCallbacks = null;
			this.requestRender();
		} else if (data === "\x1b") {
			this.dialog = null;
			this.mergeCallbacks = null;
			this.requestRender();
		}
	}

	private handleEditorInput(data: string): void {
		if (data === "\x1b[A") {
			if (this.completion !== null) this.completion.selected = Math.max(0, this.completion.selected - 1);
			else this.editor.up();
			this.requestRender();
			return;
		}
		if (data === "\x1b[B") {
			if (this.completion !== null) {
				this.completion.selected = Math.min(this.completion.candidates.length - 1, this.completion.selected + 1);
			} else this.editor.down();
			this.requestRender();
			return;
		}
		if (data === "\x1b[C") {
			this.editor.right();
			this.requestRender();
			return;
		}
		if (data === "\x1b[D") {
			this.editor.left();
			this.requestRender();
			return;
		}
		if (data === "\x1b\r" || data === "\x1b\n") {
			this.editor.newline();
			this.recomputeCompletion();
			this.requestRender();
			return;
		}
		if (data === "\x1b") {
			this.model.inputMode = false;
			this.completion = null;
			this.requestRender();
			return;
		}
		if (data === "\t") {
			this.acceptCompletion();
			this.requestRender();
			return;
		}
		if (data === "\r" || data === "\n") {
			if (this.completion !== null) {
				this.acceptCompletion();
				this.requestRender();
				return;
			}
			void this.send();
			return;
		}
		if (data === "\x7f" || data === "\b") {
			this.editor.backspace();
			this.recomputeCompletion();
			this.requestRender();
			return;
		}
		if (data.length === 1 && data >= " ") {
			this.editor.insertText(data);
			this.recomputeCompletion();
			this.requestRender();
		}
	}

	private handleNavInput(data: string): void {
		if (data === "q" || data === "\x03") {
			void this.stop();
			return;
		}
		if (data === "j" || data === "\x1b[B") {
			if (this.model.leftTab === "files") this.fileTree.cursor++;
			else this.model.scroll += 3;
			this.requestRender();
			return;
		}
		if (data === "k" || data === "\x1b[A") {
			if (this.model.leftTab === "files") this.fileTree.cursor = Math.max(0, this.fileTree.cursor - 1);
			else this.model.scroll = Math.max(0, this.model.scroll - 3);
			this.requestRender();
			return;
		}
		if (data === "t") {
			this.model.leftTab = this.model.leftTab === "sessions" ? "files" : "sessions";
			this.requestRender();
			return;
		}
		if (data === "]") {
			cycleTab(this.model, 1);
			this.requestRender();
			return;
		}
		if (data === "[") {
			cycleTab(this.model, -1);
			this.requestRender();
			return;
		}
		if (data === "x") {
			closeTab(this.model, this.model.activeTabId);
			this.requestRender();
			return;
		}
		if (data === "\t") {
			const next = pickNextSession(this.model);
			if (next !== null && next !== this.model.currentId) {
				const prev = this.model.currentId;
				if (prev !== null) {
					void this.opts.client.request(Methods.sessionDetach, { sessionId: prev }).catch(() => {});
				}
				void this.attach(next, 0);
			}
			return;
		}
		if (data === "\r" || data === "\n") {
			if (this.model.leftTab === "files") {
				this.openSelectedFile();
				this.requestRender();
			}
			return;
		}
		if (data === "i") {
			this.model.inputMode = true;
			this.requestRender();
			return;
		}
		if (data === "m" && this.model.swarm.selectedCellId !== null) {
			this.model.swarm.selectedCellId = null;
			const main = this.model.swarm.mainSessionId;
			if (main !== null && main !== this.model.currentId) void this.attach(main, 0);
			return;
		}
		if (data >= "1" && data <= "9") {
			const idx = Number.parseInt(data, 10) - 1;
			const cell = this.model.swarm.cells[idx];
			if (cell !== undefined) {
				this.model.swarm.selectedCellId = cell.cellId;
				if (this.model.swarm.mainSessionId === null && this.model.currentId !== null) {
					this.model.swarm.mainSessionId = this.model.currentId;
				}
				if (cell.sessionId !== this.model.currentId) void this.attach(cell.sessionId, 0);
			}
			return;
		}
		if (data.length === 1 && data >= " ") {
			this.model.inputMode = true;
			this.editor.insertText(data);
			this.recomputeCompletion();
			this.requestRender();
		}
	}

	private openSelectedFile(): void {
		if (this.fileTree.root === null) return;
		const nodes = scanTree(this.fileTree.root, this.fileTree.expanded);
		const n = nodes[this.fileTree.cursor];
		if (n === undefined) return;
		if (n.dir) {
			if (this.fileTree.expanded.has(n.relPath)) this.fileTree.expanded.delete(n.relPath);
			else this.fileTree.expanded.add(n.relPath);
			return;
		}
		openFileTab(this.model, `${this.fileTree.root}/${n.relPath}`, n.name);
	}

	// —— 补全 ——

	private recomputeCompletion(): void {
		const token = this.editor.currentToken()?.token ?? null;
		this.completion = computeCompletion(token, {
			files: listFileCandidates(this.fileTree.root, 200),
		});
	}

	private acceptCompletion(): void {
		if (this.completion === null) return;
		const value = this.completion.candidates[this.completion.selected];
		if (value !== undefined) this.editor.replaceCurrentToken(value);
		this.completion = null;
	}

	// —— 发送 ——

	private async send(): Promise<void> {
		const raw = this.editor.text;
		if (raw.endsWith("\\") && !raw.endsWith("\\\\")) {
			const last = this.editor.lines.length - 1;
			this.editor.lines[last] = (this.editor.lines[last] ?? "").slice(0, -1);
			this.editor.newline();
			this.editor.end();
			this.requestRender();
			return;
		}
		const text = raw.trim();
		this.editor.clear();
		if (text.length === 0 || this.model.currentId === null) {
			this.requestRender();
			return;
		}
		try {
			this.hint = "";
			const cellId = this.model.swarm.selectedCellId;
			if (cellId !== null) {
				// 插话：向该 cell 信箱发消息（04 §5.5 / 05 §6.3）
				await this.opts.client.request(Methods.swarmSend, {
					from: "main",
					to: cellId,
					payload: text,
				});
				this.hint = `→ ${cellId.slice(0, 12)} 信箱`;
			} else {
				await this.opts.client.request(Methods.sessionSend, { sessionId: this.model.currentId, text });
			}
		} catch (e) {
			this.hint = e instanceof Error ? e.message.slice(0, 60) : "发送失败";
		}
		this.requestRender();
	}

	// —— 合并/结算确认（sandbox-guard 接入后由事件触发；公开供驱动/测试） ——

	openMergeConfirm(
		files: MergeConfirmState["files"],
		note: string,
		cb: { onApply: () => void; onDiscard: () => void },
	): void {
		this.mergeCallbacks = cb;
		this.dialog = { kind: "merge", files, note };
		this.requestRender();
	}
}
