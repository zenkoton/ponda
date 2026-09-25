/**
 * 批次 4-3：dataset full 级（07 §6）/ BacktestSpec 冻结（07 §7）/ wiki 结算后增量（08 §3.1）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKTEST_METRIC_DEFINITIONS, type BacktestReport, type BacktestSpec } from "../../core/src/backtest.ts";
import { buildWiki, listPages, readPage } from "../../core/src/wiki.ts";

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

function writeSession(home: string, env: string, id: string, text: string): void {
	const dir = join(home, "envs", env, "sessions");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${id}.jsonl`),
		`${[
			JSON.stringify({ type: "session", id, cwd: "/w", provider: "p", modelId: "m1" }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-09-25T00:00:00Z",
				message: { role: "user", content: [{ type: "text", text }] },
			}),
		].join("\n")}\n`,
		"utf8",
	);
}

test("dataset export：digest 默认无全文；full 需 --yes 且含全文；RewardSignals/EnvSnapshotRef 字段齐全", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-ds-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);
	writeSession(home, "default", "aaaabbbb-1111", "观察全文 SECRET_TOKEN 观察内容");

	// full 级无 --yes → exit 4（07 §6 二次确认）
	assert.equal(run(["dataset", "export", "--level", "full"], home).code, 4);

	// digest 默认：无 text 字段
	const out1 = join(home, "ds1");
	assert.equal(run(["dataset", "export", "--out", out1], home).code, 0);
	const digestSample = JSON.parse(readFileSync(join(out1, "trajectories.jsonl"), "utf8")) as {
		steps: { text?: string }[];
		envSnapshot: { snapshotRef: string };
		reward: Record<string, unknown>;
	};
	assert.equal(digestSample.steps[0]?.text, undefined, "digest 无全文");
	assert.ok(digestSample.envSnapshot.snapshotRef.startsWith("sha256:"), "EnvSnapshotRef");
	assert.ok(
		"taskComplete" in digestSample.reward && "humanInterventions" in digestSample.reward,
		"RewardSignals 冻结字段",
	);

	// full + --yes：含全文
	const out2 = join(home, "ds2");
	const full = run(["dataset", "export", "--out", out2, "--level", "full", "--yes"], home);
	assert.equal(full.code, 0, full.out);
	const fullSample = JSON.parse(readFileSync(join(out2, "trajectories.jsonl"), "utf8")) as {
		steps: { text?: string }[];
	};
	assert.ok(fullSample.steps[0]?.text?.includes("观察全文"), "full 含观察全文");
	const manifestOut = JSON.parse(readFileSync(join(out2, "manifest.json"), "utf8")) as { level: string };
	assert.equal(manifestOut.level, "full");
});

test("BacktestSpec/BacktestReport 接口冻结（07 §7）：可构造 + 口径齐全", () => {
	const spec: BacktestSpec = {
		source: { taskId: "t1" },
		variant: {
			envSnapshotRef: "sha256:abc",
			changes: [{ kind: "skill", name: "pdf", action: "update", version: "2.0.0" }],
		},
		budget: { maxCostUsd: 2, maxSteps: 100 },
		isolation: "worktree",
		metrics: ["completion_rate", "avg_cost_usd"],
	};
	const report: BacktestReport = {
		runs: [{ variant: "v1", metrics: { completion_rate: 0.8 }, samples: 5, costUsd: 1.2 }],
		baselineRef: "sha256:abc",
		significance: "none",
	};
	assert.equal(spec.metrics.length, 2);
	assert.equal(report.runs[0]?.samples, 5);
	assert.equal(Object.keys(BACKTEST_METRIC_DEFINITIONS).length, 6, "六个口径冻结");
});

test("wiki 结算后增量：sandbox commit 后 .wiki 页 basedOn 前移（08 §3.1）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-wiki-"));
	homes.push(home);
	const ws = mkdtempSync(join(tmpdir(), "ponda-wiki-ws-"));
	writeFileSync(join(ws, "seed.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: ws });

	// 建 wiki（module 页按源码目录生成，scope=src/）
	mkdirSync(join(ws, "src"), { recursive: true });
	writeFileSync(join(ws, "src", "a.txt"), "module file\n");
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "add src"], { cwd: ws });
	buildWiki(ws, { moduleSupplier: () => "src 模块说明" });
	const pageBefore = listPages(ws).find((p) => p.frontmatter.scope.some((sc) => sc === "src" || sc === "src/"));
	assert.ok(pageBefore !== undefined, "wiki 页存在");
	const basedOnBefore = pageBefore?.frontmatter.basedOn;

	// daemon tracker 造快照活动 + 修改 → CLI commit（非 TTY 会拒绝……直接用 tracker API）
	// 此处直接验证接线函数行为：settle 后 refreshWiki 的组合（sandbox.ts 内联同款）
	const tracker = new InplaceSandboxTracker(join(home, "state.json"));
	tracker.ensure("sess-wiki-0001", ws, { autoGitInit: true });
	writeFileSync(join(ws, "src", "a.txt"), "changed\n");
	tracker.snapshotTurn("sess-wiki-0001", ws);
	const settled = tracker.settle("sess-wiki-0001", "改 seed");
	assert.ok(settled.ok, settled.detail);

	// 结算后增量（sandbox commit 内联同款调用）
	const wiki = refreshWiki(ws, { supplier: () => null });
	assert.ok(wiki.reviewed.length + wiki.refreshed.length >= 1, `触及 scope 的页被复验：${JSON.stringify(wiki)}`);
	const pageAfter = readPage(ws, pageBefore?.rel ?? "");
	assert.notEqual(pageAfter?.frontmatter.basedOn, basedOnBefore, "basedOn 前移到新 HEAD");
});

import { refreshWiki } from "../../core/src/wiki.ts";
import { InplaceSandboxTracker } from "../../daemon/src/sandbox-session.ts";
