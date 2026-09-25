/**
 * todolist 运行时（design: 05-runtime.md §2）。
 * 工具面：todo_write（批量操作 + 乐观锁）/ todo_read；
 * 事件面：todo.events 每次变更广播（TUI 右栏实时刷新）。
 */
import { randomUUID } from "node:crypto";
import type { TodoBoard, TodoItem } from "../../rpc/src/protocol.ts";

export interface TodoOp {
	op: "add" | "update" | "remove";
	id?: string;
	text?: string;
	status?: TodoItem["status"];
	parent?: string | null;
	blockedReason?: string;
}

export interface TodoDiff {
	added: TodoItem[];
	updated: TodoItem[];
	removed: string[];
}

export class TodoRuntime {
	private boards = new Map<string, TodoBoard>();

	get(taskId: string): TodoBoard {
		const existing = this.boards.get(taskId);
		if (existing !== undefined) return existing;
		const board: TodoBoard = { taskId, items: [], revision: 0 };
		this.boards.set(taskId, board);
		return board;
	}

	/**
	 * todo_write：批量操作，单次原子；update 需带 revision 乐观锁（不匹配则拒绝）。
	 * 返回新 board + diff（事件广播用）。
	 */
	write(
		taskId: string,
		ops: TodoOp[],
		opts: { expectedRevision?: number } = {},
	): { board: TodoBoard; diff: TodoDiff } {
		const board = this.get(taskId);
		if (opts.expectedRevision !== undefined && opts.expectedRevision !== board.revision) {
			throw new Error(`revision 冲突：期望 ${opts.expectedRevision}，当前 ${board.revision}`);
		}
		const diff: TodoDiff = { added: [], updated: [], removed: [] };

		for (const op of ops) {
			if (op.op === "add") {
				const item: TodoItem = {
					id: op.id ?? `t${board.items.length + 1}`,
					parent: op.parent ?? null,
					text: op.text ?? "",
					status: op.status ?? "pending",
				};
				board.items.push(item);
				diff.added.push(item);
			} else if (op.op === "update" && op.id !== undefined) {
				const item = board.items.find((x) => x.id === op.id);
				if (item === undefined) continue;
				if (op.text !== undefined) item.text = op.text;
				if (op.status !== undefined) item.status = op.status;
				if (op.parent !== undefined) item.parent = op.parent;
				if (op.blockedReason !== undefined) item.blockedReason = op.blockedReason;
				diff.updated.push({ ...item });
			} else if (op.op === "remove" && op.id !== undefined) {
				const i = board.items.findIndex((x) => x.id === op.id);
				if (i >= 0) {
					board.items.splice(i, 1);
					diff.removed.push(op.id);
				}
			}
		}

		board.revision++;
		return { board: { ...board, items: [...board.items] }, diff };
	}

	/** todo_read：全量看板 */
	read(taskId: string): TodoBoard {
		return this.get(taskId);
	}

	list(): TodoBoard[] {
		return [...this.boards.values()].map((b) => ({ ...b, items: [...b.items] }));
	}
}
