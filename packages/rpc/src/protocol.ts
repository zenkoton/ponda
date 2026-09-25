/**
 * 线协议：NDJSON 帧（一行一个 JSON 对象）上的 JSON-RPC 2.0 子集（design: 05-runtime.md §5.3）。
 * 请求/响应按 id 配对；事件经 notification（无 id）推送。
 */

export interface RpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

export interface RpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: RpcError;
}

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RpcErrorCode = {
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	timeout: -32000,
	shutdown: -32001,
} as const;

/** daemon 对外方法名（05 §5.3 接口表 + daemon 管理） */
export const Methods = {
	daemonPing: "daemon.ping",
	daemonShutdown: "daemon.shutdown",
	sessionList: "session.list",
	sessionNew: "session.new",
	sessionAttach: "session.attach",
	sessionDetach: "session.detach",
	sessionSend: "session.send",
	permissionRespond: "permission.respond",
	costSnapshot: "cost.snapshot",
	taskStatus: "task.status",
	taskStart: "task.start",
	taskConfirm: "task.confirm",
	taskReplan: "task.replan",
	taskVerify: "task.verify",
	taskSettle: "task.settle",
	taskClose: "task.close",
	taskCancel: "task.cancel",
	taskChangeRequest: "task.change_request",
	taskApproveChange: "task.approve_change",
	swarmSpawn: "swarm.spawn",
	swarmStatus: "swarm.status",
	swarmCancel: "swarm.cancel",
	swarmSend: "swarm.send",
	swarmRead: "swarm.read",
	wikiSearch: "wiki.search",
	wikiRead: "wiki.read",
	wikiUpdate: "wiki.update",
	wikiBuild: "wiki.build",
	wikiRefresh: "wiki.refresh",
} as const;

/** daemon → 客户端的通知（session.events 流等） */
export const Notifications = {
	sessionEvents: "session.events",
	permissionRequest: "permission.request",
	taskEvents: "task.events",
	swarmEvents: "swarm.events",
} as const;

// —— agent swarm（design: 05-runtime.md §6） ——

export type SwarmWorkspaceMode = "own-worktree" | "shared-worktree" | "read-only";

export type SwarmCellStatus = "spawning" | "running" | "retrying" | "done" | "failed" | "cancelled";

export interface SwarmCellInfo {
	cellId: string;
	role: string;
	brief: string;
	sessionId: string;
	status: SwarmCellStatus;
	workspaceMode: SwarmWorkspaceMode;
	workspace: string | null;
	/** own-worktree 模式的 worktree 目录（done 后清理） */
	worktreeDir: string | null;
	tokens: { input: number; output: number };
	costUsd: number;
	retries: number;
	unread: number;
	/** 最近一次 assistant 输出（递交主 agent 的结果摘要） */
	lastResult: string | null;
	lastError: string | null;
}

export interface SwarmMessage {
	id: string;
	from: string;
	to: string;
	payload: string;
	at: string;
	consumed: boolean;
}

export interface SwarmStatus {
	cells: SwarmCellInfo[];
	totals: { costUsd: number; active: number; done: number };
	maxParallel: number;
	maxSwarmCostUsd: number;
}

// —— goal 任务契约（design: 05-runtime.md §3/§4；daemon 与 TUI 共享） ——

export type TaskPhase =
	| "created"
	| "planning"
	| "confirmed"
	| "executing"
	| "verifying"
	| "settled"
	| "closed"
	| "cancelled";

export type DeliverableStatus = "planned" | "in_progress" | "delivered" | "verified" | "failed" | "changed-pending";

export interface DeliverableVerify {
	type: "command" | "manual";
	command?: string;
	expectExit?: number;
	expectOutputContains?: string;
}

export interface DeliverableSpec {
	id: string;
	name: string;
	/** 状态描述：完成后的可观察形态（给用户确认） */
	description: string;
	/** 自然语言完成判据 */
	doneCriteria: string;
	verify: DeliverableVerify;
	artifacts?: string[];
	status: DeliverableStatus;
	lastVerify?: { at: string; passed: boolean; attempt: number; detail: string };
}

export interface DeliverableChange {
	op: "add" | "remove" | "modify";
	deliverable: DeliverableSpec;
	reason?: string;
}

export interface TaskInfo {
	taskId: string;
	goal: string;
	phase: TaskPhase;
	replans: number;
	sessionId: string | null;
	workspace: string | null;
	deliverables: DeliverableSpec[];
	/** 契约修订号（变更审批通过后 +1，旧版留档） */
	contractRevision: number;
	pendingChanges: DeliverableChange[] | null;
	settledAt: string | null;
	cancelledAt: string | null;
}

// —— 事件负载类型（TUI 与 daemon 共享） ——

export interface SessionEntryEvent {
	kind: "entry";
	/** 已写入会话文件的条目数（attach 游标口径） */
	cursor: number;
	/** 原始 JSONL 行 */
	line: string;
}

export interface SessionStatusEvent {
	kind: "status";
	status: "live" | "ended" | "interrupted";
	processing: boolean;
}

export interface SessionErrorEvent {
	kind: "error";
	message: string;
}

export type SessionEvent = SessionEntryEvent | SessionStatusEvent | SessionErrorEvent;

export interface SessionListItem {
	sessionId: string;
	status: "running" | "detached" | "ended" | "interrupted";
	processing: boolean;
	attached: number;
	tokens: { input: number; output: number };
	costUsd: number;
	entryCount: number;
	workspace: string | null;
}

export interface CostSnapshot {
	env: string;
	sessions: { sessionId: string; tokens: { input: number; output: number }; costUsd: number }[];
	totals: { input: number; output: number; costUsd: number };
}

// —— 解码/判定 ——

export function isRpcRequest(m: RpcMessage): m is RpcRequest {
	return (m as RpcRequest).method !== undefined && (m as RpcRequest).id !== undefined;
}

export function isRpcResponse(m: RpcMessage): m is RpcResponse {
	return (m as RpcResponse).id !== undefined && (m as RpcResponse).result !== undefined;
}

export function isRpcError(m: RpcMessage): m is RpcResponse {
	return (m as RpcResponse).id !== undefined && (m as RpcResponse).error !== undefined;
}

export function isRpcNotification(m: RpcMessage): m is RpcNotification {
	const candidate = m as Partial<RpcNotification> & Partial<RpcRequest>;
	return candidate.method !== undefined && candidate.id === undefined;
}

/** 解码一行；坏行返回 null（调用方跳过） */
export function decodeLine(line: string): RpcMessage | null {
	try {
		const v = JSON.parse(line) as RpcMessage;
		if (typeof v !== "object" || v === null) return null;
		return v;
	} catch {
		return null;
	}
}

export function encodeMessage(m: RpcMessage): string {
	return JSON.stringify(m);
}
