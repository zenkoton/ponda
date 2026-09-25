/**
 * `ponda run -p`（headless，对标 claude -p；PM P1）：
 * - 单轮输出最终 assistant 文本（daemon 回声链路）
 * - --json 合法负载（sessionId/text/usage）
 * - --new-session 强制新建；默认续用最近 live 会话（同 sessionId、轮次递增）
 * - 结束后停止 daemon（不留后台进程）
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string): { code: number; out: string; err: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1", PONDA_MODEL: "" },
			encoding: "utf8",
			timeout: 60000,
		});
		return { code: 0, out, err: "" };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return { code: err.status ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
	}
}

afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("run -p：单轮回声输出 + daemon 生命周期", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-run-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);

	// 无模型 → daemon 回声模式（真实链路需 PONDA_MODEL/provider；此处验证管线连通）
	const r1 = run(["run", "-p", "hello ponda"], home);
	assert.equal(r1.code, 0, `输出：${r1.out}${r1.err}`);
	assert.ok(r1.out.includes("hello ponda"), `回声输出：${r1.out.trim()}`);

	// 默认续用 live 会话：第二条消息在同一会话，轮次递增
	const r2 = run(["run", "-p", "second turn"], home);
	assert.equal(r2.code, 0);
	assert.ok(r2.out.includes("second turn"), `续会话输出：${r2.out.trim()}`);

	// --new-session：新会话，轮次归 1
	const r3 = run(["run", "-p", "fresh", "--new-session"], home);
	assert.equal(r3.code, 0);
	assert.ok(r3.out.includes("fresh"), `新会话输出：${r3.out.trim()}`);

	// --json：合法负载
	const r4 = run(["run", "-p", "json round", "--json"], home);
	assert.equal(r4.code, 0);
	const payload = JSON.parse(r4.out) as { sessionId: string; env: string; text: string; usage: unknown };
	assert.ok(typeof payload.sessionId === "string" && payload.sessionId.length > 0);
	assert.equal(payload.env, "default");
	assert.ok(payload.text.includes("json round"), "text 字段");
	assert.ok(typeof payload.usage === "object");

	// 清理：停止 daemon（不留后台进程）
	assert.equal(run(["daemon", "stop"], home).code, 0);
});

test("run -p：环境不存在 exit 2；缺 prompt exit 1", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-run2-"));
	homes.push(home);
	assert.equal(run(["run", "-p", "x"], home).code, 2, "未 init → exit 2");
	assert.equal(run(["init"], home).code, 0);
	assert.equal(run(["run"], home).code, 1, "缺 prompt → exit 1");
	assert.equal(run(["daemon", "stop"], home).code, 0);
});
