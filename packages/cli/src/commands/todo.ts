/** `ponda todo ls [<taskId>]`（design: 05-runtime.md §2：CLI 与 TUI 右栏共享看板） */
import type { EnvStore } from "../../../core/src/store.ts";
import { ensureDaemon } from "../../../daemon/src/spawn.ts";
import type { TodoBoard } from "../../../rpc/src/index.ts";
import { Methods } from "../../../rpc/src/index.ts";
import { c, table } from "../ui.ts";
import { currentEnv } from "./env.ts";

export async function runTodo(
	store: EnvStore,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	if (!store.exists(env)) {
		console.error(`环境不存在：${env}（先运行 ponda init）`);
		return 2;
	}

	switch (action) {
		case "ls":
		case "list": {
			const h = await ensureDaemon(store.home, env);
			if (args[0] !== undefined) {
				const board = (await h.client.request(Methods.todoRead, { taskId: args[0] })) as TodoBoard;
				h.client.close();
				if (json) {
					console.log(JSON.stringify(board, null, 2));
					return 0;
				}
				printBoard(board);
				return 0;
			}
			const boards = (await h.client.request(Methods.todoList)) as TodoBoard[];
			h.client.close();
			if (json) {
				console.log(JSON.stringify(boards, null, 2));
				return 0;
			}
			if (boards.length === 0) {
				console.log(c.dim("暂无看板（agent 任务分解或 RPC todo.write 后出现）"));
				return 0;
			}
			for (const b of boards) printBoard(b);
			return 0;
		}
		default:
			console.error("可用动作：ls [taskId]（--env 过滤）");
			return 1;
	}
}

const STATUS_MARK: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	done: "●",
	blocked: "⚠",
	cancelled: "✕",
};

function printBoard(board: TodoBoard): void {
	console.log(c.bold(`看板 ${board.taskId}（rev ${board.revision}）`));
	if (board.items.length === 0) {
		console.log(c.dim("  （空）"));
		return;
	}
	console.log(
		table(
			["", "ID", "STATUS", "TODO"],
			board.items.map((i) => [
				STATUS_MARK[i.status] ?? "·",
				i.id,
				i.status,
				i.blockedReason !== undefined ? `${i.text}（阻塞：${i.blockedReason}）` : i.text,
			]),
			[3],
		),
	);
}
