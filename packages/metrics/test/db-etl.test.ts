/**
 * metrics.db + ETL（design: 07-data.md §4）：五表 UPSERT 幂等、游标消费、rebuild --from。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MetricsDb, newEvent, rebuildMetrics } from "../src/index.ts";

const cleanups: (() => void)[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-mdb-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function writeDay(root: string, day: string, events: unknown[]): void {
	const dir = join(root, "events");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${day}.jsonl`), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("ETL：五表落库 + 游标幂等（重跑零新增）", () => {
	const root = newDir();
	const eventsDir = join(root, "events");
	writeDay(root, "2026-09-26", [
		newEvent("session.start", { workspace: "/w/p", model: "m1" }, { env: "web", sessionId: "s1" }),
		newEvent("message", { tokens: { input: 10, output: 5 }, costUsd: 0.001 }, { env: "web", sessionId: "s1" }),
		newEvent("message", { tokens: { input: 20, output: 8 }, costUsd: 0.002 }, { env: "web", sessionId: "s1" }),
		newEvent("tool.call", { tool: "write", route: "inplace" }, { env: "web", sessionId: "s1" }),
		newEvent("task.lifecycle", { phase: "executing" }, { env: "web", taskId: "t1" }),
		newEvent("deliverable.verify", { deliverableId: "d1", passed: true, attempt: 1 }, { env: "web", taskId: "t1" }),
		newEvent("permission.request", { privilege: "execute" }, { env: "web" }),
		newEvent("permission.decision", { privilege: "execute", decision: "session" }, { env: "web" }),
		newEvent("skill.invoke", { skillName: "pdf", success: true, tokens: 100, costUsd: 0.01 }, { env: "web" }),
		newEvent("session.end", { reason: "ended" }, { env: "web", sessionId: "s1" }),
	]);

	const dbPath = join(root, "metrics.db");
	const r1 = rebuildMetrics(dbPath, eventsDir);
	assert.equal(r1.events, 10, "首轮全量消费");
	assert.ok(existsSync(dbPath));

	const db = new MetricsDb(dbPath);
	const sess = db.querySessions()[0];
	assert.ok(sess !== undefined);
	assert.equal(sess.input_tokens, 30, "message tokens 聚合");
	assert.equal(sess.output_tokens, 13);
	assert.equal(sess.cost_usd, 0.003);
	assert.equal(sess.message_count, 2);
	assert.equal(sess.tool_calls, 1);
	assert.equal(sess.end_reason, "ended");
	assert.equal(sess.model, "m1");

	const task = db.queryTasks()[0];
	assert.equal(task?.task_id, "t1");
	assert.equal(task?.phase, "executing");
	assert.equal(task?.verified, 1);

	const perm = db.queryPermissionStats()[0];
	assert.equal(perm?.requests, 1);
	assert.equal(perm?.approved, 1);

	const skill = db.querySkillStats()[0];
	assert.equal(skill?.skill, "pdf");
	assert.equal(skill?.invokes, 1);

	const cost = db.queryCostDaily()[0];
	assert.equal(cost?.day, new Date().toISOString().slice(0, 10), "按事件 ts（UTC）分日");
	assert.equal(cost?.input_tokens, 30);
	db.close();

	// 幂等：重跑不重复计数
	const r2 = rebuildMetrics(dbPath, eventsDir);
	assert.equal(r2.events, 0, "游标跳过全部已消费行");
	const db2 = new MetricsDb(dbPath);
	assert.equal(db2.querySessions()[0]?.input_tokens, 30, "重跑不重复累计");
	db2.close();
});

test("ETL：增量消费（追加事件只处理新增行）", () => {
	const root = newDir();
	const eventsDir = join(root, "events");
	writeDay(root, "2026-09-26", [newEvent("session.start", { workspace: "/w" }, { env: "web", sessionId: "s1" })]);
	const dbPath = join(root, "metrics.db");
	rebuildMetrics(dbPath, eventsDir);

	// 追加：重写该日文件（首行相同 + 两行新 message）
	writeDay(root, "2026-09-26", [
		newEvent("session.start", { workspace: "/w" }, { env: "web", sessionId: "s1" }),
		newEvent("message", { tokens: { input: 7, output: 3 }, costUsd: 0.0005 }, { env: "web", sessionId: "s1" }),
		newEvent("message", { tokens: { input: 1, output: 1 }, costUsd: 0.0001 }, { env: "web", sessionId: "s1" }),
	]);
	const r = rebuildMetrics(dbPath, eventsDir);
	assert.equal(r.events, 2, "只消费新增两行");
	const db = new MetricsDb(dbPath);
	assert.equal(db.querySessions()[0]?.input_tokens, 8);
	db.close();
});

test("rebuild --from：指定日期之后的文件重新消费", () => {
	const root = newDir();
	const eventsDir = join(root, "events");
	writeDay(root, "2026-09-25", [
		newEvent("message", { tokens: { input: 1, output: 1 }, costUsd: 0 }, { env: "web", sessionId: "s1" }),
	]);
	writeDay(root, "2026-09-26", [
		newEvent("message", { tokens: { input: 2, output: 2 }, costUsd: 0 }, { env: "web", sessionId: "s1" }),
	]);
	const dbPath = join(root, "metrics.db");
	rebuildMetrics(dbPath, eventsDir);
	// from 09-26：该文件游标重置重新消费（09-25 不重算）
	const r = rebuildMetrics(dbPath, eventsDir, { from: "2026-09-26" });
	assert.equal(r.events, 1);
	const db = new MetricsDb(dbPath);
	assert.equal(
		db.querySessions()[0]?.input_tokens,
		5,
		"09-26 行被重放叠加（1+2 初跑 + 2 重放；重放语义由调用方掌握）",
	);
	db.close();
});
