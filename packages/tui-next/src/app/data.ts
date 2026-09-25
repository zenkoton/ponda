/**
 * RPC 数据层：轮询 + daemon 通知 → 在 batch() 内落地为信号更新（单次渲染）。
 * 对应 opencode 的 SSE 事件批处理 flush 模式（16ms 窗口 → batch(store 更新)）。
 */

import { HistoryIndex } from "../../../core/src/history.ts";
import { EnvStore } from "../../../core/src/store.ts";
import type { RpcClient } from "../../../rpc/src/client.ts";
import type { RpcNotification, SessionListItem, SwarmStatus, TaskInfo } from "../../../rpc/src/protocol.ts";
import { Methods, Notifications } from "../../../rpc/src/protocol.ts";
import { batch } from "../signal.ts";
import { applySessionListRows, type SessionRow, type TuiState, taskSummaryOf } from "./state.ts";

export interface DataLayerOptions {
	state: TuiState;
	client: RpcClient;
	home: string;
}

export interface DataLayer {
	refresh(): Promise<void>;
	refreshTask(): Promise<void>;
	refreshSwarm(): Promise<void>;
	onNotification(n: RpcNotification): void;
}

export function createDataLayer(opts: DataLayerOptions): DataLayer {
	const { state, client } = opts;
	/** 已弹过契约/变更确认的任务标记（避免重复弹窗） */
	const contractPromptedFor = new Set<string>();
	const changePromptedFor = new Set<string>();

	const applySessionList = (list: SessionListItem[]): void => {
		const rows = applySessionListRows(list);
		try {
			const history = new HistoryIndex(new EnvStore(opts.home)).list({ env: state.env });
			const known = new Set(rows.map((s) => s.sessionId));
			for (const h of history) {
				if (known.has(h.sessionId)) continue;
				rows.push({
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
		state.setSessions(rows);
	};

	const refreshTask = async (): Promise<void> => {
		const r = await client.request<{ tasks: TaskInfo[] }>(Methods.taskStatus);
		const active = r.tasks.find((t) => t.phase !== "closed" && t.phase !== "cancelled") ?? null;
		batch(() => {
			state.setTask(active !== null ? taskSummaryOf(active) : null);
		});
		if (active === null || state.dialog() !== null) return;
		if (active.pendingChanges !== null && active.pendingChanges.length > 0) {
			const key = `${active.taskId}:r${active.contractRevision}`;
			if (!changePromptedFor.has(key)) {
				changePromptedFor.add(key);
				state.setDialog({
					kind: "change",
					taskId: active.taskId,
					contractRevision: active.contractRevision,
					changes: active.pendingChanges.map((c) => ({
						op: c.op,
						id: c.deliverable.id,
						name: c.deliverable.name,
						reason: c.reason,
					})),
				});
			}
			return;
		}
		if (active.phase === "planning" && !contractPromptedFor.has(active.taskId)) {
			contractPromptedFor.add(active.taskId);
			state.setDialog({
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
			});
		}
	};

	const refreshSwarm = async (): Promise<void> => {
		const st = await client.request<SwarmStatus>(Methods.swarmStatus);
		batch(() => {
			const cur = state.swarm();
			state.setSwarm({
				...cur,
				cells: st.cells,
				mainSessionId: cur.mainSessionId ?? state.currentId(),
			});
		});
	};

	const syncFileTreeRoot = (): void => {
		const cur = state.sessions().find((s) => s.sessionId === state.currentId());
		state.setFileTreeRoot(cur?.workspace ?? state.fileTree().root);
	};

	const refresh = async (): Promise<void> => {
		const list = await client.request<SessionListItem[]>(Methods.sessionList);
		const snap = await client.request<{ totals: { input: number; output: number; costUsd: number } }>(
			Methods.costSnapshot,
		);
		batch(() => {
			applySessionList(list);
			state.setTotals({ ...snap.totals });
		});
		await refreshTask();
		await refreshSwarm();
		batch(() => syncFileTreeRoot());
	};

	const onNotification = (n: RpcNotification): void => {
		if (n.method === Notifications.taskEvents) {
			void refreshTask();
			return;
		}
		if (n.method === Notifications.swarmEvents) {
			void refreshSwarm();
			return;
		}
		if (n.method === Notifications.permissionRequest) {
			const req = (
				n.params as {
					request: { requestId: string; privilege: string; reason: string; detail: Record<string, string> };
				}
			).request;
			state.setDialog({
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
			});
			return;
		}
		if (n.method !== Notifications.sessionEvents) return;
		const p = n.params as {
			sessionId: string;
			event: { kind: string; line?: string; status?: string; message?: string; processing?: boolean };
		};
		if (p.sessionId !== state.currentId()) return;
		batch(() => {
			if (p.event.kind === "entry" && typeof p.event.line === "string") {
				state.appendEntryLine(p.event.line);
			} else if (p.event.kind === "error" && typeof p.event.message === "string") {
				// daemon 处理失败（如 provider 未配置）：可见的红色 ⚠ 行，对话流不再静默中断
				state.appendError(p.event.message);
			} else if (p.event.kind === "status" && typeof p.event.status === "string") {
				const rows = state.sessions();
				const row = rows.find((s) => s.sessionId === p.sessionId);
				if (row !== undefined && (p.event.status === "live" || p.event.status === "ended")) {
					const next: SessionRow = {
						...row,
						processing: typeof p.event.processing === "boolean" ? p.event.processing : row.processing,
						status: p.event.status === "live" ? (row.attached > 0 ? "running" : "detached") : "ended",
					};
					state.setSessions(rows.map((s) => (s.sessionId === next.sessionId ? next : s)));
				}
			}
		});
	};

	return { refresh, refreshTask, refreshSwarm, onNotification };
}
