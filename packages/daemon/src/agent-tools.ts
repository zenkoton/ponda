/**
 * 模型可调用工具面（design: 05 §2.2 todolist / §6.2 swarm / 02 §7 memory）。
 * 在 coding 工具（read/bash/edit/write）之外注入：
 * - todo_write / todo_read：任务看板（05 §2：批量原子 + revision）
 * - spawn_subagent / swarm_status / send_message / cancel_subagent（05 §6）
 * - memory_write：环境记忆追加（02 §7：MEMORY.md）
 * 全部经闭包直连 daemon 运行时（TodoRuntime/SwarmRuntime），不经 RPC。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "../../agent/src/index.ts";
import { paths } from "../../core/src/paths.ts";
import type { TodoBoard } from "../../rpc/src/protocol.ts";
import type { SwarmRuntime } from "./swarm.ts";
import type { TodoOp, TodoRuntime } from "./todo.ts";

function textResult(text: string): { content: { type: "text"; text: string }[]; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}

/** 05 §2.2：todo_write（批量原子）/ todo_read；taskId 取会话当前 goal 任务，缺省 "session" */
export function createTodoTools(todos: TodoRuntime, currentTaskId: () => string): AgentTool<any>[] {
	const todoWriteSchema = Type.Object({
		ops: Type.Array(
			Type.Object({
				op: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
				id: Type.Optional(Type.String({ description: "条目 id（add 缺省自增 t1/t2…）" })),
				text: Type.Optional(Type.String()),
				status: Type.Optional(
					Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("done"),
						Type.Literal("blocked"),
						Type.Literal("cancelled"),
					]),
				),
				parent: Type.Optional(Type.String()),
				blockedReason: Type.Optional(Type.String()),
			}),
			{ description: "批量操作，单次原子；同时只保留一个 in_progress（05 §2.1）" },
		),
	});
	const write: AgentTool<typeof todoWriteSchema> = {
		name: "todo_write",
		label: "todo_write",
		description: "管理当前任务的子任务看板（长任务先建分解；每次只把一个子任务置 in_progress）。返回更新后的看板。",
		parameters: todoWriteSchema,
		async execute(_id, params) {
			const taskId = currentTaskId();
			const r = todos.write(taskId, params.ops as TodoOp[]);
			return textResult(renderBoard(r.board));
		},
	};
	const read: AgentTool<any> = {
		name: "todo_read",
		label: "todo_read",
		description: "读取当前任务的全量看板。",
		parameters: Type.Object({}),
		async execute() {
			return textResult(renderBoard(todos.read(currentTaskId())));
		},
	};
	return [write, read];
}

function renderBoard(board: TodoBoard): string {
	if (board.items.length === 0) return "(空看板)";
	return board.items.map((i) => `- [${i.status}] ${i.id}: ${i.text}`).join("\n");
}

/** 05 §6.2：spawn_subagent / swarm_status / send_message / cancel_subagent */
export function createSwarmTools(swarm: SwarmRuntime, workspace: () => string | null): AgentTool<any>[] {
	const spawnSchema = Type.Object({
		role: Type.String({ description: "角色，如 explorer/implementer/reviewer" }),
		brief: Type.String({ description: "子任务简报：目标 + 边界 + 产出契约" }),
		workspaceMode: Type.Optional(
			Type.Union([Type.Literal("own-worktree"), Type.Literal("shared-worktree"), Type.Literal("read-only")]),
		),
	});
	const spawn: AgentTool<typeof spawnSchema> = {
		name: "spawn_subagent",
		label: "spawn_subagent",
		description:
			"创建一个子 agent 分担任务（独立会话；默认 own-worktree 写隔离，只读分析用 read-only）。返回 cell 信息。",
		parameters: spawnSchema,
		async execute(_id, params) {
			const cell = swarm.spawn({
				role: params.role,
				brief: params.brief,
				workspaceMode: params.workspaceMode,
				workspace: workspace(),
			});
			return textResult(
				`cell=${cell.cellId} role=${cell.role} status=${cell.status}\nworktree=${cell.worktreeDir ?? "(shared)"}\n用 swarm_status 查进度；send_message 向其信箱插话。`,
			);
		},
	};
	const status: AgentTool<any> = {
		name: "swarm_status",
		label: "swarm_status",
		description: "全部子 agent 的状态/费用快照。",
		parameters: Type.Object({}),
		async execute() {
			const s = swarm.status();
			if (s.cells.length === 0) return textResult("(无子 agent)");
			return textResult(
				`${s.cells
					.map(
						(c) =>
							`- ${c.cellId} [${c.role}] ${c.status} retries=${c.retries} $${c.costUsd.toFixed(4)}\n  ${(c.lastResult ?? c.lastError ?? "").slice(0, 300)}`,
					)
					.join("\n")}\n(并发上限 ${s.maxParallel}，费用熔断 $${s.maxSwarmCostUsd})`,
			);
		},
	};
	const sendSchema = Type.Object({
		to: Type.String({ description: "目标 cellId" }),
		payload: Type.String(),
	});
	const send: AgentTool<typeof sendSchema> = {
		name: "send_message",
		label: "send_message",
		description: "向子 agent 信箱发定向消息（其下次被调度时收到）。",
		parameters: sendSchema,
		async execute(_id, params) {
			const m = swarm.send("main", params.to, params.payload);
			return textResult(`已投递 ${m.id} → ${m.to}`);
		},
	};
	const cancelSchema = Type.Object({ cellId: Type.String() });
	const cancel: AgentTool<typeof cancelSchema> = {
		name: "cancel_subagent",
		label: "cancel_subagent",
		description: "取消一个子 agent。",
		parameters: cancelSchema,
		async execute(_id, params) {
			const c = swarm.cancel(params.cellId);
			return textResult(`${c.cellId} → ${c.status}`);
		},
	};
	return [spawn, status, send, cancel];
}

/** 02 §7：memory_write 追加环境记忆（MEMORY.md，跨会话保留、随环境隔离） */
const memorySchema = Type.Object({
	content: Type.String({ description: "一行记忆条目" }),
});

export function createMemoryTool(home: string, env: string): AgentTool<typeof memorySchema> {
	return {
		name: "memory_write",
		label: "memory_write",
		description: "向环境长期记忆追加一条事实（跨会话保留；重要约定/结论才记，勿记过程细节）。",
		parameters: memorySchema,
		async execute(_id, params) {
			const dir = join(paths.env(home, env), "memory");
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
			const line = `- ${new Date().toISOString().slice(0, 10)} ${params.content.replace(/\s+/g, " ").trim()}`;
			appendFileSync(join(dir, "MEMORY.md"), `${line}\n`, "utf8");
			return textResult(`已记入环境记忆：${line}`);
		},
	};
}

/** 工具面配套的系统提示段（05 §2.1 分解纪律 / §6 swarm 用法） */
export function agentToolsSystemPrompt(): string {
	return [
		"",
		"## 任务执行约定",
		"- 长任务先用 todo_write 建立子任务分解；每次只把一个子任务置 in_progress，完成即置 done。",
		"- 可并行/分职责的工作用 spawn_subagent 生成子 agent（默认 own-worktree 写隔离）；用 swarm_status 跟踪、send_message 插话、cancel_subagent 取消。",
		"- 跨会话需要记住的事实（约定、决策、偏好）用 memory_write 记入环境记忆。",
	].join("\n");
}
