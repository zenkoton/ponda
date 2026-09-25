import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RpcClient } from "../../rpc/src/client.ts";
import { type DeliverableSpec, Methods, Notifications, type TaskInfo } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";
import { TaskRuntime } from "../src/goal.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-goal-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

function cmdDeliverable(id: string, name: string, command: string): DeliverableSpec {
	return {
		id,
		name,
		description: `${name} 的状态描述`,
		doneCriteria: `${command} 退出 0`,
		verify: { type: "command", command, expectExit: 0 },
		status: "planned",
	};
}

test("生命周期：start→confirm（校准生成+基线试跑）→deliver→verify 失败→修复→verify 通过→settled→close", () => {
	const ws = newDir();
	writeFileSync(join(ws, "app.txt"), "old\n");
	const rt = new TaskRuntime();

	const t0 = rt.start({
		goal: "让 app.txt 内容为 done",
		workspace: ws,
		deliverables: [cmdDeliverable("d1", "app.txt 内容", "grep -q done app.txt")],
	});
	assert.equal(t0.phase, "planning");

	const t1 = rt.confirm(t0.taskId);
	assert.equal(t1.phase, "executing");

	// 校准代码落盘 + verify.json + 基线试跑记录（05 §4.2）
	const dir = join(ws, ".ponda", "verify", t0.taskId);
	assert.ok(existsSync(join(dir, "d1.sh")));
	const manifest = JSON.parse(readFileSync(join(dir, "verify.json"), "utf8")) as {
		entries: { deliverable: string }[];
	};
	assert.equal(manifest.entries[0]?.deliverable, "d1");
	const d1 = t1.deliverables.find((x) => x.id === "d1");
	assert.equal(d1?.lastVerify?.passed, false, "基线试跑：内容未改应失败");
	assert.ok(d1?.lastVerify?.detail.includes("exit=1"));

	// 收尾比对：仍失败 → failed
	const t2 = rt.verify(t0.taskId);
	assert.equal(t2.deliverables.find((x) => x.id === "d1")?.status, "failed");
	assert.equal(t2.phase, "verifying", "存在失败不进入 settled");

	// "agent 修复"
	writeFileSync(join(ws, "app.txt"), "done\n");
	const t3 = rt.verify(t0.taskId);
	assert.equal(t3.deliverables.find((x) => x.id === "d1")?.status, "verified");
	assert.equal(t3.phase, "settled");

	const t4 = rt.close(t0.taskId);
	assert.equal(t4.phase, "closed");

	// skill-state envelope 同步（06 §3）
	const env = rt.envelope(t0.taskId);
	assert.equal(env.state.phase, "done");
	const verification = env.state.verification as Record<string, { status: string }>;
	assert.equal(verification.d1?.status, "verified");
});

test("校准重跑上限：3 轮后拒绝", () => {
	const ws = newDir();
	const rt = new TaskRuntime();
	const t = rt.start({
		goal: "永不达成",
		workspace: ws,
		deliverables: [cmdDeliverable("d1", "不可能", "false")],
	});
	rt.confirm(t.taskId);
	rt.verify(t.taskId);
	rt.verify(t.taskId);
	rt.verify(t.taskId);
	assert.throws(() => rt.verify(t.taskId), /上限/);
});

test("replan 上限：2 次后要求改目标", () => {
	const ws = newDir();
	const rt = new TaskRuntime();
	const t = rt.start({ goal: "g", workspace: ws });
	rt.replan(t.taskId);
	rt.replan(t.taskId);
	assert.throws(() => rt.replan(t.taskId), /上限/);
});

test("契约变更：申请挂 changed-pending，批准 → 修订+1 且脚本重写；拒绝 → 恢复", () => {
	const ws = newDir();
	const rt = new TaskRuntime();
	const t = rt.start({
		goal: "g",
		workspace: ws,
		deliverables: [cmdDeliverable("d1", "旧目标", "true")],
	});
	rt.confirm(t.taskId);

	const modified = cmdDeliverable("d1", "新目标", "echo hi");
	const t1 = rt.changeRequest(t.taskId, [{ op: "modify", deliverable: modified, reason: "需求变更" }]);
	assert.equal(t1.deliverables.find((x) => x.id === "d1")?.status, "changed-pending");
	assert.ok(t1.pendingChanges !== null);

	// 未审批前脚本未变
	const dir = join(ws, ".ponda", "verify", t.taskId);
	assert.ok(readFileSync(join(dir, "d1.sh"), "utf8").includes("true"));

	const t2 = rt.approveChange(t.taskId, true);
	assert.equal(t2.contractRevision, 1);
	assert.equal(t2.pendingChanges, null);
	assert.ok(readFileSync(join(dir, "d1.sh"), "utf8").includes("echo hi"), "批准后校准脚本重写");
	assert.equal(t2.deliverables.find((x) => x.id === "d1")?.name, "新目标");

	// 拒绝路径
	rt.changeRequest(t.taskId, [{ op: "remove", deliverable: modified }]);
	const t4 = rt.approveChange(t.taskId, false);
	assert.equal(t4.contractRevision, 1, "拒绝不增修订");
	assert.equal(t4.deliverables.length, 1);
	assert.equal(t4.deliverables[0]?.status, "planned");
});

test("取消：未验证成果标记 failed", () => {
	const ws = newDir();
	const rt = new TaskRuntime();
	const t = rt.start({ goal: "g", workspace: ws, deliverables: [cmdDeliverable("d1", "x", "true")] });
	rt.confirm(t.taskId);
	const t2 = rt.cancel(t.taskId);
	assert.equal(t2.phase, "cancelled");
	assert.equal(t2.deliverables[0]?.status, "failed");
	assert.throws(() => rt.close(t.taskId), /cancelled/);
});

test("manual 成果：verify 记 delivered 不阻塞 settled", () => {
	const ws = newDir();
	const rt = new TaskRuntime();
	const t = rt.start({
		goal: "g",
		workspace: ws,
		deliverables: [
			cmdDeliverable("d1", "自动", "true"),
			{
				id: "d2",
				name: "人工",
				description: "",
				doneCriteria: "人工看",
				verify: { type: "manual" },
				status: "planned",
			},
		],
	});
	rt.confirm(t.taskId);
	const t2 = rt.verify(t.taskId);
	assert.equal(t2.deliverables.find((x) => x.id === "d2")?.status, "delivered");
	assert.equal(t2.phase, "settled");
});

// —— RPC 端到端 ——

test("RPC：task.* 全链路 + taskEvents 通知", async () => {
	const home = newDir();
	const ws = newDir();
	writeFileSync(join(ws, "out.txt"), "ok\n");
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();

	const c = new RpcClient();
	await c.connect(core.socketPath());
	const events: { taskId: string; event: { kind: string } }[] = [];
	c.setNotificationHandler((n) => {
		if (n.method === Notifications.taskEvents) {
			events.push(n.params as { taskId: string; event: { kind: string } });
		}
	});

	const started = await c.request<TaskInfo>(Methods.taskStart, {
		goal: "RPC 任务",
		workspace: ws,
		deliverables: [cmdDeliverable("d1", "out.txt", "grep -q ok out.txt")],
	});
	assert.equal(started.phase, "planning");

	const confirmed = await c.request<TaskInfo>(Methods.taskConfirm, { taskId: started.taskId });
	assert.equal(confirmed.phase, "executing");

	const verified = await c.request<TaskInfo>(Methods.taskVerify, { taskId: started.taskId });
	assert.equal(verified.phase, "settled");
	assert.equal(verified.deliverables[0]?.status, "verified");

	const status = await c.request<{ tasks: TaskInfo[] }>(Methods.taskStatus);
	assert.equal(status.tasks.length, 1);

	const closed = await c.request<TaskInfo>(Methods.taskClose, { taskId: started.taskId });
	assert.equal(closed.phase, "closed");

	await new Promise((r) => setTimeout(r, 100));
	assert.ok(events.some((e) => e.event.kind === "phase"));
	c.close();
});
