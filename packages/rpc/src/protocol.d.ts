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
export declare const RpcErrorCode: {
	readonly methodNotFound: -32601;
	readonly invalidParams: -32602;
	readonly internal: -32603;
	readonly timeout: -32000;
	readonly shutdown: -32001;
};
/** daemon 对外方法名（05 §5.3 接口表 + daemon 管理） */
export declare const Methods: {
	readonly daemonPing: "daemon.ping";
	readonly daemonShutdown: "daemon.shutdown";
	readonly sessionList: "session.list";
	readonly sessionNew: "session.new";
	readonly sessionAttach: "session.attach";
	readonly sessionDetach: "session.detach";
	readonly sessionSend: "session.send";
	readonly permissionRespond: "permission.respond";
	readonly costSnapshot: "cost.snapshot";
	readonly taskStatus: "task.status";
	readonly taskStart: "task.start";
	readonly taskConfirm: "task.confirm";
	readonly taskReplan: "task.replan";
	readonly taskVerify: "task.verify";
	readonly taskSettle: "task.settle";
	readonly taskClose: "task.close";
	readonly taskCancel: "task.cancel";
	readonly taskChangeRequest: "task.change_request";
	readonly taskApproveChange: "task.approve_change";
	readonly swarmSpawn: "swarm.spawn";
	readonly swarmStatus: "swarm.status";
	readonly swarmCancel: "swarm.cancel";
	readonly swarmSend: "swarm.send";
	readonly swarmRead: "swarm.read";
	readonly wikiSearch: "wiki.search";
	readonly wikiRead: "wiki.read";
	readonly wikiUpdate: "wiki.update";
	readonly wikiBuild: "wiki.build";
	readonly wikiRefresh: "wiki.refresh";
};
/** daemon → 客户端的通知（session.events 流等） */
export declare const Notifications: {
	readonly sessionEvents: "session.events";
	readonly permissionRequest: "permission.request";
	readonly taskEvents: "task.events";
	readonly swarmEvents: "swarm.events";
};
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
	tokens: {
		input: number;
		output: number;
	};
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
	totals: {
		costUsd: number;
		active: number;
		done: number;
	};
	maxParallel: number;
	maxSwarmCostUsd: number;
}
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
	lastVerify?: {
		at: string;
		passed: boolean;
		attempt: number;
		detail: string;
	};
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
	tokens: {
		input: number;
		output: number;
	};
	costUsd: number;
	entryCount: number;
	workspace: string | null;
}
export interface CostSnapshot {
	env: string;
	sessions: {
		sessionId: string;
		tokens: {
			input: number;
			output: number;
		};
		costUsd: number;
	}[];
	totals: {
		input: number;
		output: number;
		costUsd: number;
	};
}
export declare function isRpcRequest(m: RpcMessage): m is RpcRequest;
export declare function isRpcResponse(m: RpcMessage): m is RpcResponse;
export declare function isRpcError(m: RpcMessage): m is RpcResponse;
export declare function isRpcNotification(m: RpcMessage): m is RpcNotification;
/** 解码一行；坏行返回 null（调用方跳过） */
export declare function decodeLine(line: string): RpcMessage | null;
export declare function encodeMessage(m: RpcMessage): string;
//# sourceMappingURL=protocol.d.ts.map
