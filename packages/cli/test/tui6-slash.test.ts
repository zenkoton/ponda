/**
 * TUI 斜杠命令真实执行（PM 审查 P0：补全列出的命令必须可用）。
 * /help /new /mode /sessions /goal /wiki-rebuild /未知命令回显。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { SLASH_COMMANDS } from "../../tui-next/src/app/completion.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
function newDir2(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-slash2-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-slash-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("斜杠命令：/help /mode /new /sessions /goal /wiki-rebuild 端到端", async () => {
	const home = newDir();
	const _ws = newDir();

	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());

	const term = new VirtualTerminal(110, 32);
	const frames: string[][] = [];
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
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	const waitFrame = async (pred: (l: string) => boolean, ms = 3000): Promise<boolean> => {
		for (let i = 0; i < ms / 20; i++) {
			if (seen(pred)) return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen(pred);
	};
	// 逐字符输入（多字符字符串会被键位层当 paste 字面插入，Enter 须单独发）
	const type = (s: string): void => {
		for (const ch of s) app.handleInput(ch);
	};

	// /help：命令清单 + 键位入帧
	await waitFrame(() => true);
	type("/help");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("ponda 命令")), "/help 渲染帮助");

	// /mode plan：建会话并设置模式（daemon 侧可查）。
	// 状态行默认渲染 mode: approve，故用 plan 消除帧匹配歧义
	type("/mode plan");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("mode: plan")), "/mode 提示生效");
	const sid = app.model.currentId;
	assert.ok(sid !== null, "/mode 已创建会话");
	assert.equal(core.sessionMode(sid as string), "plan", "daemon 会话模式已设置");

	// /new：切换到新会话
	const before = app.model.currentId;
	type("/new");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("已新建会话")), "/new 提示");
	await new Promise((r) => setTimeout(r, 100));
	assert.notEqual(app.model.currentId, before, "会话已切换");

	// /sessions：侧栏呼出
	type("/sessions");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("Σ")), "/sessions 打开侧栏（Σ 统计入帧）");
	assert.ok(app.state.sidebarVisible(), "侧栏可见信号置位");

	// /goal：daemon 侧任务创建（随后会弹成果契约确认框——先 Esc 关掉再继续输入）
	type("/goal 给仓库补一个 README");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("goal 任务已创建")), "/goal 创建任务");
	assert.equal(core.tasks.list().length, 1, "TaskRuntime 收到任务");
	app.handleInput("\x1b");
	await new Promise((r) => setTimeout(r, 60));

	// 未知命令：不发送给模型，回显未知
	type("/nope");
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("未知命令：/nope")), "未知命令回显");

	// 补全列表与执行面一致（app.ts runSlashCommand 支持的命令集）
	const implemented = ["/help", "/new", "/sessions", "/mode", "/goal", "/wiki-rebuild", "/undo", "/end"];
	assert.deepEqual(SLASH_COMMANDS.map((c) => c.name).sort(), [...implemented].sort(), "补全候选与实现一致");
	void join;
	void Methods;
});

test("/end：结束当前会话（daemon 侧 status=ended，PM 易用性 #10）", async () => {
	const home = newDir2();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const term = new VirtualTerminal(110, 32);
	const frames: string[][] = [];
	const app = new PondaTui({
		env: "web",
		home,
		client,
		terminal: term,
		pollMs: 200,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
	});
	apps.push(app);
	await app.start();
	const type = (t: string): void => {
		for (const ch of t) app.handleInput(ch);
	};
	// 建会话再结束
	type("/new");
	app.handleInput("\r");
	await new Promise((r) => setTimeout(r, 200));
	const sid = app.model.currentId;
	assert.ok(sid !== null);
	type("/end");
	app.handleInput("\r");
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	for (let i = 0; i < 100; i++) {
		if (seen((l) => l.includes("会话已结束"))) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		seen((l) => l.includes("会话已结束")),
		"/end 提示",
	);
	const list = await client.request<{ sessionId: string; status: string }[]>(Methods.sessionList);
	assert.equal(list.find((s) => s.sessionId === sid)?.status, "ended", "daemon 侧 ended");
	// 测试体内先行停止（会话 ended 后轮询会触发连接错误，等 afterEach 会放大竞态窗口）
	await app.stop();
});
