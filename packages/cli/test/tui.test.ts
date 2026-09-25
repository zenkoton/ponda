import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../../core/src/paths.ts";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui/src/ponda/app.ts";
import { PondaEditor } from "../../tui/src/ponda/editor.ts";
import { newFileTreeState } from "../../tui/src/ponda/files.ts";
import {
	applySessionList,
	extractContent,
	groupByWorkspace,
	newReadModel,
	pickNextSession,
	pushEntryLine,
} from "../../tui/src/ponda/model.ts";
import { renderFrame, stripAnsi } from "../../tui/src/ponda/view.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

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

// —— 视图模型 ——

test("pushEntryLine：user/assistant(thinking)/notice 解析与游标口径", () => {
	const m = newReadModel("web");
	pushEntryLine(m, JSON.stringify({ type: "session", id: "s1", cwd: "/w" })); // header：占游标
	pushEntryLine(
		m,
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我重构" }] } }),
	);
	pushEntryLine(
		m,
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
	pushEntryLine(m, JSON.stringify({ type: "custom", customType: "ponda.ended" }));
	assert.equal(m.entrySeq, 4);
	assert.deepEqual(
		m.entries.map((e) => e.kind),
		["user", "assistant", "notice"],
	);
	assert.equal(m.entries[1]?.thinking, "先看模块结构");
	assert.equal(m.entries[1]?.text, "# 计划\n分三步");
	assert.ok(m.entries[2]?.text.includes("ended"));
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
	const m = newReadModel("web");
	applySessionList(m, [
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
	const groups = groupByWorkspace(m.sessions);
	assert.deepEqual(
		groups.map((g) => g.workspace),
		["(no workspace)", "/w/a", "/w/b"],
	);
	m.currentId = "b1";
	assert.equal(pickNextSession(m), "a1");
});

// —— 纯渲染 ——

test("renderReadView：三栏布局/左栏分组与合计/中栏 markdown+思考折叠/右栏占位", () => {
	const m = newReadModel("web-dev");
	applySessionList(m, [
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
	]);
	m.currentId = "sess-aaaabbbbcccc";
	m.totals = { input: 900, output: 100, costUsd: 0.42 };
	pushEntryLine(m, JSON.stringify({ type: "session", id: "s" }));
	pushEntryLine(
		m,
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "写个计划" }] } }),
	);
	pushEntryLine(
		m,
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

	const editor = new PondaEditor();
	const lines = renderFrame(
		{ model: m, input: { editor, completion: null, hint: "" }, dialog: null, fileTree: newFileTreeState() },
		100,
		24,
	).map(stripAnsi);
	assert.equal(lines.length, 24);
	// 头部
	assert.ok(lines[0]?.includes("ponda tui"));
	assert.ok(lines[0]?.includes("env:web-dev"));
	assert.ok(lines[0]?.includes("sess-aaa"));
	// 三栏分隔符出现在 body 行（页签行/输入区行不含，按内容过滤）
	const bodyRows = lines
		.slice(1, lines.length - 1)
		.filter((r) => !r.startsWith("❯") && !r.includes("补全") && r.includes("│"));
	assert.ok(bodyRows.length >= 5, `body 行数：${bodyRows.length}`);
	for (const row of bodyRows) {
		assert.equal((row.match(/│/g) ?? []).length, 2, `分隔符数量：${row}`);
	}
	// 左栏：工作区分组 + token/费用 + 合计
	assert.ok(bodyRows.some((r) => r.includes("▾ /Users/x/proj (1)")));
	assert.ok(bodyRows.some((r) => r.includes("sess-aaa")));
	assert.ok(bodyRows.some((r) => r.includes("1.0k")));
	assert.ok(bodyRows.some((r) => r.includes("Σ")));
	// 中栏：用户消息 + markdown 渲染 + 思考折叠
	assert.ok(bodyRows.some((r) => r.includes("you ▸")));
	assert.ok(bodyRows.some((r) => r.includes("写个计划")));
	assert.ok(bodyRows.some((r) => r.includes("思考")));
	assert.ok(bodyRows.some((r) => r.includes("重构计划")));
	assert.ok(bodyRows.some((r) => r.includes("补测试")));
	// 右栏：todolist 占位 + 会话元信息
	assert.ok(bodyRows.some((r) => r.includes("TODOLIST")));
	assert.ok(bodyRows.some((r) => r.includes("M6 接入")));
	assert.ok(bodyRows.some((r) => r.includes("status")));
	// 底部键提示
	assert.ok(lines[23]?.includes("q 退出"));
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

	// 重放内容进入帧（TuiMainScreen 渲染为异步调度，轮询等待）
	const has = (pred: (frame: string[]) => boolean) => frames.some(pred);
	for (let i = 0; i < 150 && !has((f) => f.some((l) => l.includes("Review"))); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		has((f) => f.some((l) => l.includes("Review"))),
		"重放的 markdown 应出现在帧中",
	);
	assert.ok(has((f) => f.some((l) => l.includes("思考"))));
	assert.ok(has((f) => f.some((l) => l.includes("/w/proj"))));

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

	// 键处理：j 滚动（帧数增长，等待调度）、q 退出
	const before = frames.length;
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
