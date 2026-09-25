import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { AgentLoop } from "../../daemon/src/agent-loop.ts";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-tui6-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("对话流：无会话时发送自动建会话并收到回复（opencode 式流程）", async () => {
	const home = newDir();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const ctl = new RpcClient();
	await ctl.connect(core.socketPath());
	assert.equal((await ctl.request<unknown[]>(Methods.sessionList)).length, 0, "初始无会话");

	const term = new VirtualTerminal(110, 32);
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

	assert.equal(app.model.currentId, null, "无 live 会话不自动 attach");
	assert.ok(
		has((f) => f.some((l) => l.includes("输入消息开始对话"))),
		"空态引导",
	);

	// 默认输入焦点：直接打字 + Enter（无需按 i 进入输入模式）
	for (const ch of "你好") app.handleInput(ch);
	await waitFrame((f) => f.some((l) => l.includes("❯ 你好▏")));
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => /echo\(\d+\): 你好/.test(l)));
	assert.ok(
		has((f) => f.some((l) => /echo\(\d+\): 你好/.test(l))),
		"自动建会话后收到回复",
	);
	assert.notEqual(app.model.currentId, null);
	assert.equal(app.editor.text, "", "发送后编辑器清空");
	// 连续第二轮对话：继续直接输入即可
	for (const ch of "再来一句") app.handleInput(ch);
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => /echo\(\d+\): 再来一句/.test(l)));
	assert.ok(
		has((f) => f.some((l) => /echo\(\d+\): 再来一句/.test(l))),
		"对话流可持续",
	);
	ctl.close();
});

test("对话流：处理中指示 + daemon error 事件渲染为 ⚠ 行", async () => {
	const home = newDir();
	// 慢且必败的循环：先展示「生成中」，结束后广播 error 事件
	const slowBoom: AgentLoop = {
		name: "slow-boom",
		async process() {
			await new Promise((r) => setTimeout(r, 400));
			throw new Error("model not found: glm/x（真实 provider 配置随 P4 完整接入）");
		},
	};
	const core = new DaemonCore({ home, env: "web", loop: slowBoom });
	cores.push(core);
	await core.start();
	const ctl = new RpcClient();
	await ctl.connect(core.socketPath());
	const { sessionId } = await ctl.request<{ sessionId: string }>(Methods.sessionNew, { workspace: null });

	const term = new VirtualTerminal(110, 32);
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
	await app.start(sessionId);
	const has = (pred: (f: string[]) => boolean) => frames.some(pred);
	const waitFrame = async (pred: (f: string[]) => boolean, ms = 4000): Promise<void> => {
		for (let i = 0; i < ms / 20 && !has(pred); i++) await new Promise((r) => setTimeout(r, 20));
	};

	for (const ch of "hi") app.handleInput(ch);
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => l.includes("生成中")));
	assert.ok(
		has((f) => f.some((l) => l.includes("生成中"))),
		"处理中指示可见",
	);
	await waitFrame((f) => f.some((l) => l.includes("⚠ model not found")));
	assert.ok(
		has((f) => f.some((l) => l.includes("⚠ model not found"))),
		"daemon error 事件渲染为 ⚠ 行（不再静默）",
	);
	ctl.close();
});

test("leader 键：输入未发送的文本时 ctrl+x 仍可切侧栏", async () => {
	const home = newDir();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const term = new VirtualTerminal(110, 32);
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const app = new PondaTui({ env: "web", home, client, terminal: term, pollMs: 60000 });
	apps.push(app);
	await app.start();

	for (const ch of "jq") app.handleInput(ch); // 输入内容（j/q 此时应插入字符）
	assert.equal(app.editor.text, "jq");
	assert.equal(app.state.sidebarVisible(), false);
	app.handleInput("\x18"); // ctrl+x → leader
	app.handleInput("s"); // → 切侧栏
	assert.equal(app.state.sidebarVisible(), true, "leader 后切出侧栏");
	assert.equal(app.editor.text, "jq", "编辑器内容不受 leader 影响");
	await app.stop();
});
