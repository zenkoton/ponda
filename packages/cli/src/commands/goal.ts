/** `ponda goal`：goal 任务管理（design: 05-runtime.md §3；经 daemon RPC） */

import type { EnvStore } from "../../../core/src/store.ts";
import { ensureDaemon } from "../../../daemon/src/spawn.ts";
import { Methods, type TaskInfo } from "../../../rpc/src/index.ts";
import { c, table, truncate } from "../ui.ts";
import { currentEnv } from "./env.ts";

export async function runGoal(
	store: EnvStore,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	if (!store.exists(env)) {
		console.error(`环境不存在：${env}`);
		return 2;
	}
	const handle = await ensureDaemon(store.home, env);
	const call = <T>(m: string, p?: Record<string, unknown>) => handle.client.request<T>(m, p);

	try {
		switch (action) {
			case "start": {
				const goal = args.join(" ") || (typeof flags.get("goal") === "string" ? (flags.get("goal") as string) : "");
				if (goal.length === 0) {
					console.error("用法：ponda goal start <目标描述> [--workspace <dir>]");
					return 1;
				}
				const ws = typeof flags.get("workspace") === "string" ? (flags.get("workspace") as string) : null;
				const t = await call<TaskInfo>(Methods.taskStart, { goal, workspace: ws });
				if (json) {
					console.log(JSON.stringify(t, null, 2));
					return 0;
				}
				console.log(c.green("✓"), `goal 任务已创建（planning）：${truncate(t.goal, 50)}`);
				console.log(`  taskId: ${t.taskId}`);
				console.log(`  成果契约 ${t.deliverables.length} 项，等待确认：ponda goal confirm ${t.taskId}`);
				return 0;
			}

			case "ls":
			case "list":
			case "status": {
				const id = args[0];
				const r = await call<{ tasks: TaskInfo[] }>(
					Methods.taskStatus,
					id !== undefined ? { taskId: id } : undefined,
				);
				if (json) {
					console.log(JSON.stringify(r.tasks, null, 2));
					return 0;
				}
				if (r.tasks.length === 0) {
					console.log(c.dim("无 goal 任务（ponda goal start <目标> 创建）"));
					return 0;
				}
				console.log(
					table(
						["TASK", "PHASE", "REV", "DELIVERABLES", "GOAL"],
						r.tasks.map((t) => [
							t.taskId.slice(0, 8),
							t.phase,
							`v${t.contractRevision}`,
							`${t.deliverables.filter((d) => d.status === "verified").length}/${t.deliverables.length}✔`,
							truncate(t.goal, 36),
						]),
						[0, 1, 3, 4],
					),
				);
				if (id !== undefined) {
					const t = r.tasks[0];
					if (t !== undefined) {
						for (const d of t.deliverables) {
							const mark = d.status === "verified" ? c.green("✔") : d.status === "failed" ? c.red("✘") : "◐";
							console.log(`  ${mark} ${d.id} ${d.name} [${d.verify.type}] ${truncate(d.doneCriteria, 40)}`);
							if (d.lastVerify !== undefined) {
								console.log(
									c.dim(
										`     上次校准: ${d.lastVerify.passed ? "pass" : "FAIL"} ${d.lastVerify.detail.slice(0, 60)}`,
									),
								);
							}
						}
					}
				}
				return 0;
			}

			case "confirm":
			case "replan":
			case "verify":
			case "settle":
			case "close":
			case "cancel": {
				const id = args[0];
				if (id === undefined) {
					console.error(`用法：ponda goal ${action} <taskId>`);
					return 1;
				}
				const methodMap: Record<string, string> = {
					confirm: Methods.taskConfirm,
					replan: Methods.taskReplan,
					verify: Methods.taskVerify,
					settle: Methods.taskSettle,
					close: Methods.taskClose,
					cancel: Methods.taskCancel,
				};
				const t = await call<TaskInfo>(methodMap[action] as string, { taskId: id });
				if (json) {
					console.log(JSON.stringify(t, null, 2));
					return 0;
				}
				console.log(c.green("✓"), `${id.slice(0, 8)} → ${t.phase}（v${t.contractRevision}）`);
				return 0;
			}

			default:
				console.error(
					"可用动作：start <goal> | ls/status [id] | confirm | replan | verify | settle | close | cancel [--env E]",
				);
				return 1;
		}
	} catch (e) {
		console.error(`${c.red("goal 错误")}：${e instanceof Error ? e.message : String(e)}`);
		return 1;
	} finally {
		handle.client.close();
	}
}
