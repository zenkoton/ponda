import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, type SwarmCellInfo, type SwarmStatus } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui/src/ponda/app.ts";
import { stripAnsi } from "../../tui/src/ponda/view.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-m8-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("TUI：子 agent 切换条 + 数字键切换视图 + 插话入信箱 + m 切回 main", async () => {
	const home = newDir();
	const ws = newDir();
	writeFileSync(join(ws, "base"), "x");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: ws });

	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const ctl = new RpcClient();
	await ctl.connect(core.socketPath());

	const term = new VirtualTerminal(110, 34);
	const frames: string[][] = [];
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const app = new PondaTui({
		env: "web",
		home,
		client,
		terminal: term,
		pollMs: 60000,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
	});
	apps.push(app);
	await app.start();
	const has = (pred: (f: string[]) => boolean) => frames.some(pred);
	const waitFrame = async (pred: (f: string[]) => boolean, ms = 4000): Promise<void> => {
		for (let i = 0; i < ms / 20 && !has(pred); i++) await new Promise((r) => setTimeout(r, 20));
	};

	// spawn 两个 cell（swarmEvents 驱动刷新）
	const c1 = await ctl.request<SwarmCellInfo>(Methods.swarmSpawn, {
		role: "实现者",
		brief: "实现导出",
		workspace: ws,
	});
	await ctl.request<SwarmCellInfo>(Methods.swarmSpawn, { role: "审校者", brief: "审校文档", workspace: ws });

	await waitFrame((f) => f.some((l) => l.includes("main │") && l.includes("实现者")));
	assert.ok(
		has((f) => f.some((l) => l.includes("1 实现者") && l.includes("2 审校者"))),
		"chips 渲染",
	);

	// 数字键 1：切到 cell 会话视图（中栏显示其 brief 的会话内容）
	app.handleInput("1");
	await waitFrame((f) => f.some((l) => l.includes("echo(2): 实现导出")));
	assert.equal(app.model.swarm.selectedCellId, c1.cellId);
	assert.equal(app.model.currentId, c1.sessionId, "中栏 attach 到 cell 会话");

	// 插话：输入模式 + 文本 + Enter → 信箱（而非 session.send）
	app.handleInput("i");
	for (const ch of "加个测试") app.handleInput(ch);
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => l.includes("信箱")));
	const box = await ctl.request<{ payload: string }[]>(Methods.swarmRead, { cellId: c1.cellId });
	assert.ok(
		box.some((m) => m.payload === "加个测试"),
		"插话进入信箱",
	);

	// m 切回 main（先退出输入模式）
	app.handleInput("\x1b");
	app.handleInput("m");
	const mainSession = app.model.swarm.mainSessionId;
	await waitFrame((f) => f.some((l) => l.includes("main") && l.includes("实现者")));
	assert.equal(app.model.currentId, mainSession);
	assert.equal(app.model.swarm.selectedCellId, null);

	// 费用/状态在 swarm.status 可见
	const st = await ctl.request<SwarmStatus>(Methods.swarmStatus);
	assert.ok(st.cells.length >= 2);
	ctl.close();
});
