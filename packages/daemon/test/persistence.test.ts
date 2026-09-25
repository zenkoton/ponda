/**
 * 状态持久化（design: 05 §5.1/§5.2，06 §3）：Task/Todo 快照落
 * envs/<env>/state/{tasks,todos}/，daemon 重启（新 DaemonCore 同 home）不丢；
 * 有工作区的任务 envelope 双写 <workspace>/.ponda/state/<taskId>.json；
 * goal resume 依托快照恢复（不依赖会话历史重放）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../../core/src/paths.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, type TaskInfo } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";
import { TaskRuntime } from "../src/goal.ts";
import { TodoRuntime } from "../src/todo.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("TaskRuntime：快照落盘 + 新实例恢复（含 envelope 与契约历史）", () => {
	const home = newDir("ponda-pers-");
	const ws = newDir("ponda-pers-ws-");
	const stateDir = join(paths.env(home, "web"), "state", "tasks");

	const rt1 = new TaskRuntime({ stateDir });
	const t = rt1.start({ goal: "写 README", workspace: ws });
	rt1.confirm(t.taskId);
	assert.ok(existsSync(join(stateDir, `${t.taskId}.json`)), "任务快照存在");
	assert.ok(existsSync(join(ws, ".ponda", "state", `${t.taskId}.json`)), "envelope 双写工作区");

	// "重启"：新 runtime 从盘上恢复
	const rt2 = new TaskRuntime({ stateDir });
	const restored = rt2.get(t.taskId);
	assert.equal(restored.phase, "executing", "phase 恢复");
	assert.equal(restored.goal, "写 README");
	assert.equal(rt2.envelope(t.taskId).state.goal, "写 README", "envelope 恢复");
	assert.ok(rt2.envelope(t.taskId).revision > 0, "revision 保留");
});

test("TodoRuntime：看板写穿 + 新实例恢复", () => {
	const home = newDir("ponda-pers-");
	const stateDir = join(paths.env(home, "web"), "state", "todos");
	const t1 = new TodoRuntime({ stateDir });
	t1.write("task-1", [
		{ op: "add", id: "a", text: "第一步" },
		{ op: "add", id: "b", text: "第二步", status: "in_progress" },
	]);
	const t2 = new TodoRuntime({ stateDir });
	const board = t2.read("task-1");
	assert.equal(board.items.length, 2);
	assert.equal(board.revision, 1);
	assert.equal(board.items[1]?.status, "in_progress");
});

test("DaemonCore 端到端：daemon 重启后任务/看板/任务 resume 全部可用", async () => {
	const home = newDir("ponda-pers-e2e-");
	const ws = newDir("ponda-pers-ws2-");

	const core1 = new DaemonCore({ home, env: "web" });
	cores.push(core1);
	await core1.start();
	const c1 = new RpcClient();
	await c1.connect(core1.socketPath());
	const started = await c1.request<TaskInfo>(Methods.taskStart, {
		goal: "持久化验证",
		workspace: ws,
	});
	await c1.request(Methods.taskConfirm, { taskId: started.taskId });
	await c1.request(Methods.todoWrite, {
		taskId: started.taskId,
		ops: [{ op: "add", id: "t1", text: "子任务" }],
	});
	c1.close();
	await core1.shutdown(0);
	cores.splice(cores.indexOf(core1), 1);

	// "崩溃重启"：同 home 新 DaemonCore
	const core2 = new DaemonCore({ home, env: "web" });
	cores.push(core2);
	await core2.start();
	const c2 = new RpcClient();
	await c2.connect(core2.socketPath());

	const status = await c2.request<{ tasks: TaskInfo[] }>(Methods.taskStatus, {});
	assert.equal(status.tasks.length, 1, "任务恢复");
	assert.equal(status.tasks[0]?.phase, "executing");

	const boards = await c2.request<{ taskId: string; items: unknown[] }[]>(Methods.todoList);
	assert.equal(boards.length, 1, "看板恢复");
	assert.equal(boards[0]?.items.length, 1);

	// resume：executing 任务可恢复执行（05 §5.2）
	const resumed = await c2.request<TaskInfo>(Methods.taskResume, { taskId: started.taskId });
	assert.equal(resumed.phase, "executing");

	// planning/settled 任务 resume 被相位守卫拒绝
	const t2r = await c2.request<TaskInfo>(Methods.taskStart, { goal: "另一个", workspace: ws });
	let rejected = false;
	try {
		await c2.request(Methods.taskResume, { taskId: t2r.taskId });
	} catch {
		rejected = true;
	}
	assert.ok(rejected, "planning 任务不可 resume");
	c2.close();
});

test("快照文件为合法 JSON（信封字段齐全，可被外部工具审计）", () => {
	const home = newDir("ponda-pers-");
	const ws = newDir("ponda-pers-ws3-");
	const stateDir = join(paths.env(home, "web"), "state", "tasks");
	const rt = new TaskRuntime({ stateDir });
	const t = rt.start({ goal: "审计", workspace: ws });
	const raw = JSON.parse(readFileSync(join(stateDir, `${t.taskId}.json`), "utf8")) as {
		info: { taskId: string };
		envelope: { taskId: string; schemaId: string; revision: number };
	};
	assert.equal(raw.info.taskId, t.taskId);
	assert.equal(raw.envelope.taskId, t.taskId);
	assert.ok(raw.envelope.schemaId.startsWith("coding-task@"));
});
