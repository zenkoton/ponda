import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { aggregateSkillStats, JsonlSink, newEvent, readEvents, scrubPayload, scrubString } from "../src/index.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

const SCRUB = { home: "/Users/tester", workspace: "/Users/tester/work/proj" };

test("scrubString：家目录/工作区/密钥形态", () => {
	const r = scrubString("读取 /Users/tester/work/proj/src/a.ts 失败", SCRUB);
	assert.equal(r.value, "读取 <ws>/src/a.ts 失败");
	assert.equal(r.hit.paths, true);

	const s2 = scrubString("curl -H 'Authorization: Bearer abc123' https://x", SCRUB);
	assert.ok(s2.value.includes("bearer <redacted>") || s2.value.includes("Bearer <redacted>"));
	assert.equal(s2.hit.secrets, true);

	const s3 = scrubString("--api-key=supersecretvalue123 https://api", SCRUB);
	assert.ok(s3.value.includes("<redacted>"));
	assert.ok(!s3.value.includes("supersecretvalue123"));
});

test("scrubPayload：递归与密钥键名", () => {
	const { value, hit } = scrubPayload(
		{ path: "/Users/tester/other/x", apiKey: "sk-live-123", nested: { token: "t", safe: 1 } },
		SCRUB,
	);
	assert.equal((value as Record<string, unknown>).path, "~/other/x");
	assert.equal((value as Record<string, unknown>).apiKey, "<redacted>");
	const nested = (value as { nested: Record<string, unknown> }).nested;
	assert.equal(nested.token, "<redacted>");
	assert.equal(nested.safe, 1);
	assert.equal(hit.secrets, true);
});

test("JsonlSink：批量落盘、脱敏标记、readEvents 读回", () => {
	const dir = mkdtempSync(join(tmpdir(), "ponda-metrics-"));
	dirs.push(dir);
	const sink = new JsonlSink({ dir, scrub: SCRUB, flushThreshold: 2 });

	const e1 = sink.push(
		newEvent("tool.call", { tool: "bash", command: "cat /Users/tester/work/proj/a" }, { env: "default" }),
	);
	assert.equal(e1.scrubbed.paths, true);
	assert.ok((e1.payload as { command: string }).command.includes("<ws>"));

	sink.push(newEvent("message", { role: "assistant", tokens: { input: 10 } }, { env: "default" }));
	// 达到阈值 2 → 已落盘
	const day = new Date().toISOString().slice(0, 10);
	let events = readEvents(dir, day);
	assert.equal(events.length, 2);
	assert.equal(events[0].type, "tool.call");

	// 阈值外的：close 时 flush
	sink.push(newEvent("session.end", { reason: "done" }, { env: "default" }));
	sink.close();
	events = readEvents(dir, day);
	assert.equal(events.length, 3);
	assert.ok(events.every((e) => typeof e.id === "string" && e.id.length === 26));
});

test("aggregateSkillStats：07 §5 指标口径", () => {
	const stats = aggregateSkillStats([
		{
			skillName: "react",
			version: "1.0.0",
			invokedAt: "t",
			success: true,
			retriedWithin10min: false,
			rollbackInvolved: false,
			humanIntervention: false,
			tokens: 1000,
			costUsd: 0.01,
		},
		{
			skillName: "react",
			version: "1.0.0",
			invokedAt: "t",
			success: false,
			retriedWithin10min: true,
			rollbackInvolved: true,
			humanIntervention: true,
			tokens: 3000,
			costUsd: 0.03,
		},
		{
			skillName: "vitest",
			version: "2.0.0",
			invokedAt: "t",
			success: true,
			retriedWithin10min: false,
			rollbackInvolved: false,
			humanIntervention: false,
			tokens: 500,
			costUsd: 0.005,
		},
	]);
	assert.equal(stats.length, 2);
	const react = stats.find((s) => s.skillName === "react");
	assert.equal(react?.invokes, 2);
	assert.equal(react?.successRate, 0.5);
	assert.equal(react?.rollbackRate, 0.5);
	assert.equal(react?.avgTokensPerInvoke, 2000);
	assert.equal(react?.avgCostPerInvoke, 0.02);
});
