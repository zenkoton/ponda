/** `ponda stats`（07 §4/§5）：rebuild 入库 + sessions/cost/tasks/permissions 读指标层 + audit 抽检 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string): { code: number; out: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1" },
			encoding: "utf8",
		});
		return { code: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string };
		return { code: err.status ?? 1, out: err.stdout ?? "" };
	}
}

afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("stats rebuild → 指标层读取（sessions/cost/tasks/permissions/audit）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-stats-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);

	// 手工构造事件流（等价 daemon 产出）
	const eventsDir = join(home, "telemetry", "events");
	mkdirSync(eventsDir, { recursive: true });
	const day = new Date().toISOString().slice(0, 10);
	const mk = (type: string, payload: unknown, extra: Record<string, unknown> = {}) =>
		JSON.stringify({
			id: `x-${Math.random()}`,
			ts: new Date().toISOString(),
			env: "default",
			sessionId: null,
			agentId: null,
			taskId: null,
			type,
			payload,
			scrubbed: { paths: false, envVars: false, secrets: false },
			...extra,
		});
	const lines = [
		mk("session.start", { workspace: "/w/p" }, { sessionId: "s-1" }),
		mk("message", { tokens: { input: 100, output: 40 }, costUsd: 0.01 }, { sessionId: "s-1" }),
		mk("task.lifecycle", { phase: "executing" }, { taskId: "t-1" }),
		mk("deliverable.verify", { deliverableId: "d1", passed: true }, { taskId: "t-1" }),
		mk("permission.request", { privilege: "write" }),
		mk("permission.decision", { privilege: "write", decision: "once" }),
		mk("session.end", { reason: "ended" }, { sessionId: "s-1" }),
	];
	writeFileSync(join(eventsDir, `${day}.jsonl`), `${lines.join("\n")}\n`, "utf8");

	// rebuild
	const r = run(["stats", "rebuild"], home);
	assert.equal(r.code, 0, r.out);
	assert.ok(existsSync(join(home, "telemetry", "metrics.db")), "metrics.db 生成");

	// sessions 读指标层
	const s = run(["stats", "sessions"], home);
	assert.equal(s.code, 0);
	assert.ok(s.out.includes("140"), "tokens 聚合入帧"); // 100+40

	// tasks / permissions
	const t = run(["stats", "tasks"], home);
	assert.ok(t.out.includes("executing"), t.out);
	const p = run(["stats", "permissions"], home);
	assert.ok(p.out.includes("write"), p.out);
	assert.ok(p.out.includes("100%"), "批准率");

	// cost
	const cost = run(["stats", "cost"], home);
	assert.ok(cost.out.includes("0.01"), cost.out);

	// audit：无密钥残留 → 退出 0
	const a = run(["stats", "audit"], home);
	assert.equal(a.code, 0, a.out);

	// 幂等：再 rebuild 不重复计数
	run(["stats", "rebuild"], home);
	const s2 = run(["stats", "sessions"], home);
	assert.ok(s2.out.includes("140"), "重跑不重复");
});
