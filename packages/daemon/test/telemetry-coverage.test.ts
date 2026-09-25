/**
 * telemetry 埋点覆盖（design: 07 §2 表格）：真实链路一轮后，事件流应包含
 * session.start / message(tokens) / task.lifecycle / deliverable.verify /
 * permission.request+decision / swarm.cell / session.end；daemon 退出时 ETL
 * 进 metrics.db（sessions 表可查）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { MetricsDb, readEvents } from "../../metrics/src/index.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, type TaskInfo } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";
import { fauxAssistantMessage, registerFauxProvider } from "../src/pi-loop.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const fauxes: FauxProviderRegistration[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const f of fauxes.splice(0)) f.unregister();
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("埋点覆盖：会话/任务/权限/swarm 全链事件 + 退出时 ETL 入库", async () => {
	const home = newDir("ponda-tel-");
	const ws = newDir("ponda-tel-ws-");
	// telemetry 显式开启（07 §1 默认关闭）
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "ponda.json"), JSON.stringify({ telemetry: { enabled: true } }), "utf8");

	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([fauxAssistantMessage("回复一")]);

	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();

	const c = new RpcClient();
	await c.connect(core.socketPath());

	// 会话消息（message 埋点：tokens/costUsd）
	const { sessionId } = await c.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });
	await c.request(Methods.sessionSend, { sessionId, text: "hello" });
	for (let i = 0; i < 100; i++) {
		const l = await c.request<{ processing: boolean }[]>(Methods.sessionList);
		if (l[0]?.processing === false) break;
		await new Promise((r) => setTimeout(r, 20));
	}

	// 任务全流程（task.lifecycle + deliverable.verify）
	const t = await c.request<TaskInfo>(Methods.taskStart, {
		goal: "写 README",
		workspace: ws,
		deliverables: [
			{
				id: "d1",
				name: "README",
				description: "存在",
				doneCriteria: "文件存在",
				verify: { type: "command", command: "test -f README.md", expectExit: 0 },
				status: "planned",
			},
		],
	});
	await c.request(Methods.taskConfirm, { taskId: t.taskId });

	// 权限往返
	const permP = core.requestPermission(
		{ privilege: "execute", reason: "测试", detail: { tool: "bash", command: "ls", mode: "B" } },
		5000,
	);
	await new Promise((r) => setTimeout(r, 50));
	const pending = [...core.server.connections];
	void pending;
	// 直接应答（测试无 TUI）：经 dispatch
	const reqId = await waitPermissionId(core);
	await c.request(Methods.permissionRespond, { requestId: reqId, approved: true, scope: "session" });
	await permP;

	c.close();
	await core.shutdown(0);
	cores.splice(cores.indexOf(core), 1);

	// 事件流断言
	const day = new Date().toISOString().slice(0, 10);
	const events = readEvents(join(home, "telemetry"), day);
	const types = new Set(events.map((e) => e.type));
	assert.ok(types.has("session.start"), "session.start");
	const msg = events.find((e) => e.type === "message");
	assert.ok(msg !== undefined, "message");
	assert.ok(typeof (msg.payload as { tokens?: unknown }).tokens === "object", "message payload 含 tokens（07 §2）");
	assert.ok(types.has("task.lifecycle"), "task.lifecycle");
	assert.ok(types.has("deliverable.verify"), "deliverable.verify");
	assert.ok(types.has("permission.request"), "permission.request");
	const decision = events.find((e) => e.type === "permission.decision");
	assert.ok(decision !== undefined, "permission.decision");
	assert.equal((decision.payload as { privilege?: string }).privilege, "execute", "decision 带特权");
	assert.ok(types.has("session.end"), "session.end（daemon-shutdown）");

	// daemon 退出 ETL：metrics.db sessions 表可查
	assert.ok(existsSync(join(home, "telemetry", "metrics.db")), "metrics.db 生成");
	const db = new MetricsDb(join(home, "telemetry", "metrics.db"));
	const sess = db.querySessions().find((r) => r.session_id === sessionId);
	assert.ok(sess !== undefined, "sessions 表有该会话");
	assert.ok(sess.input_tokens + sess.output_tokens > 0, "tokens 入库");
	const task = db.queryTasks().find((r) => r.task_id === t.taskId);
	assert.ok(task !== undefined, "tasks 表有该任务");
	db.close();
});

test("swarm.cell 埋点：cell 状态迁移入事件流", async () => {
	const home = newDir("ponda-tel2-");
	mkdirSync(home, { recursive: true });
	writeFileSync(join(home, "ponda.json"), JSON.stringify({ telemetry: { enabled: true } }), "utf8");

	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const c = new RpcClient();
	await c.connect(core.socketPath());
	const cell = await c.request<{ cellId: string }>(Methods.swarmSpawn, {
		role: "explorer",
		brief: "看看",
		workspaceMode: "shared-worktree",
		workspace: null,
	});
	await new Promise((r) => setTimeout(r, 300));
	c.close();
	await core.shutdown(0);
	cores.splice(cores.indexOf(core), 1);

	const day = new Date().toISOString().slice(0, 10);
	const events = readEvents(join(home, "telemetry"), day);
	const cells = events.filter((e) => e.type === "swarm.cell");
	assert.ok(cells.length >= 1, `swarm.cell 事件（得到 ${cells.length}）`);
	assert.ok(cells.some((e) => (e.payload as { cellId?: string }).cellId === cell.cellId));
});

/** 从 core 拿当前 pending 权限请求 id（测试助手：无 TUI 时的应答入口） */
function waitPermissionId(core: DaemonCore): Promise<string> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		const tick = () => {
			const pending = (core as unknown as { pendingPermissions: Map<string, unknown> }).pendingPermissions;
			const first = pending?.keys().next();
			if (first !== undefined && first.done === false) {
				resolve(first.value as string);
			} else if (Date.now() - t0 > 3000) {
				reject(new Error("no pending permission"));
			} else {
				setTimeout(tick, 20);
			}
		};
		tick();
	});
}
