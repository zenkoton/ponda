import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../../core/src/paths.ts";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { renderStateFrame } from "../../tui-next/src/app/components.ts";
import {
	applySessionListRows,
	createTuiState,
	extractContent,
	groupByWorkspace,
	pickNextSession,
} from "../../tui-next/src/app/state.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-tui-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});
const cores: DaemonCore[] = [];
const apps: { stop(): Promise<void> }[] = [];

// —— 视图状态 ——

test("appendEntryLine：user/assistant(thinking)/notice 解析与游标口径", () => {
	const state = createTuiState("web");
	state.appendEntryLine(JSON.stringify({ type: "session", id: "s1", cwd: "/w" })); // header：占游标
	state.appendEntryLine(
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我重构" }] } }),
	);
	state.appendEntryLine(
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "先看模块结构" },
					{ type: "text", text: "# 计划\n分三步" },
				],
			},
		}),
	);
	state.appendEntryLine(JSON.stringify({ type: "custom", customType: "ponda.ended" }));
	assert.equal(state.entrySeq(), 4);
	assert.deepEqual(
		state.entries().map((e) => e.kind),
		["user", "assistant", "notice"],
	);
	assert.equal(state.entries()[1]?.thinking, "先看模块结构");
	assert.equal(state.entries()[1]?.text, "# 计划\n分三步");
	assert.ok(state.entries()[2]?.text.includes("ended"));
});

test("extractContent：字符串与块数组两形态", () => {
	assert.deepEqual(extractContent("plain"), { text: "plain", thinking: null });
	assert.deepEqual(
		extractContent([
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "t" },
		]),
		{
			text: "a",
			thinking: "t",
		},
	);
});

test("groupByWorkspace/pickNextSession", () => {
	const rows = applySessionListRows([
		{
			sessionId: "b1",
			workspace: "/w/a",
			status: "running",
			processing: false,
			attached: 1,
			tokens: { input: 1, output: 1 },
			costUsd: 0,
			entryCount: 1,
		},
		{
			sessionId: "a1",
			workspace: "/w/b",
			status: "detached",
			processing: false,
			attached: 0,
			tokens: { input: 2, output: 2 },
			costUsd: 0,
			entryCount: 1,
		},
		{
			sessionId: "c1",
			workspace: null,
			status: "ended",
			processing: false,
			attached: 0,
			tokens: { input: 3, output: 3 },
			costUsd: 0,
			entryCount: 1,
		},
	]);
	const groups = groupByWorkspace(rows);
	assert.deepEqual(
		groups.map((g) => g.workspace),
		["(no workspace)", "/w/a", "/w/b"],
	);
	assert.equal(pickNextSession(rows, "b1"), "a1");
});

// —— 纯渲染 ——

test("renderStateFrame：三栏布局/左栏分组与合计/中栏 markdown+思考折叠/右栏占位", () => {
	const state = createTuiState("web-dev");
	state.setSessions(
		applySessionListRows([
			{
				sessionId: "sess-aaaabbbbcccc",
				workspace: "/Users/x/proj",
				status: "running",
				processing: true,
				attached: 1,
				tokens: { input: 900, output: 100 },
				costUsd: 0.42,
				entryCount: 5,
			},
		]),
	);
	state.setCurrentId("sess-aaaabbbbcccc");
	state.setTotals({ input: 900, output: 100, costUsd: 0.42 });
	state.appendEntryLine(JSON.stringify({ type: "session", id: "s" }));
	state.appendEntryLine(
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "写个计划" }] } }),
	);
	state.appendEntryLine(
		JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "考虑测试与回滚".repeat(20) },
					{ type: "text", text: "# 重构计划\n1. 抽接口\n2. 补测试" },
				],
			},
		}),
	);

	const lines = renderStateFrame(state, 100, 24).map(stripAnsi);
	assert.equal(lines.length, 24);
	// 页眉：ponda + env + 会话点（opencode 式双侧页眉）
	assert.ok(lines[0]?.includes("ponda"));
	assert.ok(lines[0]?.includes("web-dev"));
	assert.ok(lines[0]?.includes("sess-aaa"));
	// 对话流：用户消息（❯ 前缀）+ markdown + 思考折叠
	const chat = lines.slice(1, lines.length - 3).map((r) => r.trimStart());
	assert.ok(
		chat.some((r) => r.startsWith("❯") && r.includes("写个计划")),
		"用户消息带 ❯ 前缀",
	);
	assert.ok(chat.some((r) => r.includes("思考")));
	assert.ok(chat.some((r) => r.includes("重构计划")));
	assert.ok(chat.some((r) => r.includes("补测试")));
	// 生成中指示（processing 会话）
	assert.ok(lines.some((r) => r.includes("生成中")));
	// 圆角输入框 + 占位符之外的编辑器内容 + 页脚键提示
	assert.ok(lines.some((r) => r.trimStart().startsWith("╭")));
	assert.ok(lines.some((r) => r.trimStart().startsWith("│ ❯")));
	assert.ok(lines[23]?.includes("⏎ 发送"));
	assert.ok(lines[23]?.includes("1 会话"), "页脚左侧会话计数");
});

test("renderStateFrame：侧栏（Tab 呼出）与本地错误条目", () => {
	const state = createTuiState("web");
	state.setSessions(
		applySessionListRows([
			{
				sessionId: "sess-aaaabbbbcccc",
				workspace: "/w/p",
				status: "detached",
				processing: false,
				attached: 0,
				tokens: { input: 900, output: 100 },
				costUsd: 0.42,
				entryCount: 5,
			},
		]),
	);
	state.setTotals({ input: 900, output: 100, costUsd: 0.42 });
	state.cycleSidebar(); // 隐藏 → 会话页
	const withSidebar = renderStateFrame(state, 100, 24).map(stripAnsi);
	assert.ok(
		withSidebar.some((r) => r.includes("会话")),
		"侧栏标题",
	);
	assert.ok(
		withSidebar.some((r) => r.includes("/w/p (1)")),
		"工作区分组",
	);
	assert.ok(
		withSidebar.some((r) => r.includes("sess-aaa")),
		"会话行",
	);
	state.cycleSidebar(); // 会话页 → 文件页
	assert.ok(state.leftTab() === "files");
	state.cycleSidebar(); // 文件页 → 隐藏
	assert.ok(state.sidebarVisible() === false);

	// 本地错误条目（daemon error 事件 → 红色 ⚠ 行）
	state.setMode("nav"); // 任意模式均可渲染
	state.setCurrentId("sess-aaaabbbbcccc");
	state.appendError("model not found: 未配置 provider");
	const withError = renderStateFrame(state, 100, 24).map(stripAnsi);
	assert.ok(
		withError.some((r) => r.includes("⚠ model not found")),
		"错误条目可见",
	);
});

// —— 端到端：daemon RPC → attach 游标重放 → 实时事件 → 滚动/退出 ——

test("PondaTui 端到端：daemon 会话 attach 重放渲染 + 实时事件 + 键处理", async () => {
	const home = newHome();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();

	const setup = new RpcClient();
	await setup.connect(core.socketPath());
	const created = await setup.request<{ sessionId: string }>(Methods.sessionNew, { workspace: "/w/proj" });
	const { sessionId } = created;
	// 绕过 daemon 直接落盘一段含 thinking 的 pi 格式历史（attach cursor=0 会重放）
	const file = join(paths.env(home, "web"), "sessions", `${sessionId}.jsonl`);
	appendFileSync(
		file,
		[
			JSON.stringify({
				type: "message",
				message: { role: "user", content: [{ type: "text", text: "review 一下" }] },
			}),
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "扫描依赖" },
						{ type: "text", text: "## Review\n循环依赖 1 处" },
					],
				},
			}),
		]
			.map((l) => `${l}\n`)
			.join(""),
		"utf8",
	);

	const term = new VirtualTerminal(100, 30);
	const frames: string[][] = [];
	let stoppedResolve: () => void = () => {};
	const stopped = new Promise<void>((resolve) => {
		stoppedResolve = resolve;
	});
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const app = new PondaTui({
		env: "web",
		home,
		client,
		terminal: term,
		pollMs: 60000,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
		onStopped: () => stoppedResolve(),
	});
	apps.push(app);
	await app.start(sessionId);

	// 重放内容进入帧（信号驱动帧循环，轮询等待）
	const has = (pred: (frame: string[]) => boolean) => frames.some(pred);
	for (let i = 0; i < 150 && !has((f) => f.some((l) => l.includes("Review"))); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		has((f) => f.some((l) => l.includes("Review"))),
		"重放的 markdown 应出现在帧中",
	);
	assert.ok(has((f) => f.some((l) => l.includes("思考"))));
	assert.ok(
		has((f) => f.some((l) => l.includes("1 会话"))),
		"页脚会话计数",
	);

	// 实时事件：send → echo 回复进入新帧（echo 序号来自 daemon 内部计数，正则匹配）
	await client.request(Methods.sessionSend, { sessionId, text: "继续" });
	const echoRe = /echo\(\d+\): 继续/;
	for (let i = 0; i < 150 && !has((f) => f.some((l) => echoRe.test(l))); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		has((f) => f.some((l) => echoRe.test(l))),
		"实时 assistant 事件应入帧",
	);

	// 键处理：esc 进导航 → j 滚动（信号变化触发新帧）→ q 退出
	const before = frames.length;
	app.handleInput("\x1b");
	app.handleInput("j");
	for (let i = 0; i < 50 && frames.length <= before; i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(frames.length > before, "j 触发重渲染");
	app.handleInput("q");
	await Promise.race([stopped, new Promise((_, rej) => setTimeout(() => rej(new Error("未退出")), 2000))]);
	assert.equal(app.isRunning, false);

	// detach 已通知 daemon（会话在 daemon 中继续存在）
	const list = await setup.request<{ sessionId: string; status: string; attached: number }[]>(Methods.sessionList);
	const row = list.find((s) => s.sessionId === sessionId);
	assert.equal(row?.attached, 0);
	assert.equal(row?.status, "detached");
	setup.close();
	client.close();
});
