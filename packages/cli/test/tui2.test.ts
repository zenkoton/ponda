import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { computeCompletion, renderCompletionPopup } from "../../tui-next/src/app/completion.ts";
import { renderStateFrame } from "../../tui-next/src/app/components.ts";
import { PondaEditor } from "../../tui-next/src/app/editor.ts";
import { listFileCandidates, readFilePreview, scanTree } from "../../tui-next/src/app/files.ts";
import { type CenterTab, closeTab, createTuiState, cycleTab, openFileTab } from "../../tui-next/src/app/state.ts";
import type { Terminal } from "../../tui-next/src/terminal.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-tui2-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

// —— 编辑器 ——

test("PondaEditor：输入/换行/退格/光标/多行", () => {
	const e2 = new PondaEditor();
	e2.insertText("hello world");
	e2.left();
	e2.left();
	e2.backspace();
	assert.equal(e2.text, "hello wold");
	e2.clear();
	e2.insertText("ab");
	e2.backspace();
	assert.equal(e2.text, "a");
	e2.newline();
	e2.insertText("第二行");
	assert.equal(e2.text, "a\n第二行");
	assert.equal(e2.row, 1);
	e2.up();
	assert.equal(e2.row, 0);
	e2.end();
	e2.insertText("X");
	assert.equal(e2.text, "aX\n第二行");
	e2.down();
	e2.home();
	e2.backspace(); // 行首退格合并到上一行
	assert.equal(e2.text, "aX第二行");
	assert.equal(e2.row, 0);
});

test("PondaEditor：currentToken 与 replaceCurrentToken", () => {
	const e = new PondaEditor();
	e.insertText("看下 @sr");
	const t = e.currentToken();
	assert.equal(t?.token, "@sr");
	e.replaceCurrentToken("src/main.ts");
	assert.equal(e.text, "看下 @src/main.ts ");
	const e2 = new PondaEditor();
	e2.insertText("/com");
	assert.equal(e2.currentToken()?.token, "/com");
	e2.replaceCurrentToken("/compact");
	assert.equal(e2.text, "/compact ");
	assert.equal(e2.currentToken(), null, "替换后无进行中 token");
});

// —— 补全 ——

test("computeCompletion：@文件与/命令、模糊过滤", () => {
	const files = ["src/a.ts", "src/sub/b.md", "readme.md"];
	const at = computeCompletion("@a", { files });
	assert.ok(at !== null && at.kind === "@");
	assert.deepEqual(at.candidates, ["src/a.ts", "readme.md"], "子序列模糊命中（源顺序）");

	const slash = computeCompletion("/com", { files: [] });
	assert.ok(slash !== null && slash.kind === "/");
	assert.ok(slash.candidates.includes("/compact"));

	assert.equal(computeCompletion("普通文本", { files }), null);
	assert.equal(computeCompletion("@zzz", { files }), null);
	const popup = renderCompletionPopup({ kind: "/", query: "com", candidates: ["/compact"], selected: 0 }, 60);
	assert.ok(popup[0]?.includes("Tab"));
	assert.ok(popup[1]?.includes("▸/compact"));
});

// —— 文件树 ——

test("scanTree/listFileCandidates/readFilePreview", () => {
	const ws = newDir();
	mkdirSync(join(ws, "src", "sub"), { recursive: true });
	mkdirSync(join(ws, "node_modules", "x"), { recursive: true });
	writeFileSync(join(ws, "src", "a.ts"), "const a = 1;\n");
	writeFileSync(join(ws, "src", "sub", "b.md"), "# B\n");
	writeFileSync(join(ws, "root.txt"), "r\n");

	const expanded = new Set<string>();
	let nodes = scanTree(ws, expanded);
	assert.deepEqual(
		nodes.map((n) => n.relPath),
		["root.txt", "src"],
		"默认折叠仅顶层，node_modules 被忽略",
	);
	expanded.add("src");
	nodes = scanTree(ws, expanded);
	assert.deepEqual(
		nodes.map((n) => n.relPath),
		["root.txt", "src", "src/a.ts", "src/sub"],
	);
	expanded.add("src/sub");
	nodes = scanTree(ws, expanded);
	assert.ok(nodes.some((n) => n.relPath === "src/sub/b.md"));

	const cands = listFileCandidates(ws);
	assert.ok(cands.includes("src/a.ts"));
	assert.ok(!cands.some((c) => c.includes("node_modules")));

	const p = readFilePreview(join(ws, "src", "a.ts"));
	assert.equal(p.markdown, false);
	assert.ok(p.lines[0]?.includes("const a = 1;"));
	const pm = readFilePreview(join(ws, "src", "sub", "b.md"));
	assert.equal(pm.markdown, true);
});

// —— 弹窗（modal 居中覆盖帧）——

test("renderStateFrame：权限/合并弹窗居中覆盖帧", () => {
	const state = createTuiState("web");
	const withDialog = renderStateFrame(state, 100, 24).length; // 基线行数
	state.setDialog({
		kind: "permission",
		requestId: "p1",
		privilege: "write",
		reason: "写工作区外文件 /etc/hosts",
		detail: { tool: "write", targetPath: "/etc/hosts", mode: "C" },
	});
	const lines = renderStateFrame(state, 100, 24).map(stripAnsi);
	assert.equal(lines.length, withDialog);
	assert.ok(lines.some((l) => l.includes("权限申请：write")));
	assert.ok(lines.some((l) => l.includes("/etc/hosts")));
	assert.ok(lines.some((l) => l.includes("[a] 总是允许")));
	assert.ok(
		lines.some((l) => l.includes("╭")),
		"圆角弹窗边框",
	);
	assert.ok(lines.some((l) => l.includes("╰")));

	state.setDialog({
		kind: "merge",
		files: [
			{ path: "src/a.ts", status: "M" },
			{ path: "src/new.ts", status: "A" },
		],
		note: "worktree wt-1 结算",
	});
	const m = renderStateFrame(state, 100, 24).map(stripAnsi);
	assert.ok(m.some((l) => l.includes("src/a.ts")));
	assert.ok(m.some((l) => l.includes("wt-1")));
	assert.ok(m.some((l) => l.includes("[Enter] apply")));
});

// —— 页签模型 ——

test("openFileTab/closeTab/cycleTab（纯函数）", () => {
	let tabs: CenterTab[] = [{ id: "chat", kind: "chat" }];
	tabs = openFileTab(tabs, "/w/a.ts", "a.ts");
	tabs = openFileTab(tabs, "/w/b.md", "b.md");
	assert.equal(tabs.length, 3);
	let active = "file:/w/b.md";
	tabs = openFileTab(tabs, "/w/a.ts", "a.ts"); // 已存在 → 不重复
	assert.equal(tabs.length, 3);
	active = "file:/w/a.ts";
	active = cycleTab(tabs, active, 1);
	assert.equal(active, "file:/w/b.md");
	active = cycleTab(tabs, active, 1); // 回到 chat
	assert.equal(active, "chat");
	const closedInactive = closeTab(tabs, active, "file:/w/a.ts");
	tabs = closedInactive.tabs;
	assert.equal(tabs.length, 2);
	assert.equal(closedInactive.activeId, "chat", "关闭非激活页不改激活页");
	const chat = tabs[0];
	assert.ok(chat?.kind === "chat");
	const closedChat = closeTab(tabs, "chat", chat.id); // 主会话页不可关（忽略语义）
	assert.equal(closedChat.tabs.length, 2);
	assert.equal(closedChat.activeId, "chat");
	tabs = openFileTab(tabs, "/w/c.ts", "c.ts");
	active = cycleTab(tabs, "file:/w/b.md", 1);
	assert.equal(active, "file:/w/c.ts");
	const closed = closeTab(tabs, active, active); // 关闭激活页 → 回退到前一页（b.md）
	assert.equal(closed.tabs.length, 2);
	assert.equal(closed.activeId, "file:/w/b.md");
});

// —— 端到端：输入区/补全/发送/页签/弹窗 ——

test("PondaTui 交互端到端：输入、@补全、发送、文件页签、权限与合并弹窗", async () => {
	const home = newDir();
	const ws = newDir();
	writeFileSync(join(ws, "a.ts"), "export const x = 1;\n");
	writeFileSync(join(ws, "note.md"), "# Note\nhello\n");

	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const setup = new RpcClient();
	await setup.connect(core.socketPath());
	const created = await setup.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });
	const { sessionId } = created;

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
	const waitFrame = async (pred: (f: string[]) => boolean, ms = 3000): Promise<void> => {
		for (let i = 0; i < ms / 20 && !has(pred); i++) await new Promise((r) => setTimeout(r, 20));
	};

	// 默认输入焦点：直接打字即入帧（圆角输入框 + ❯ 前缀 + ▏光标）
	await waitFrame(() => true);
	app.handleInput("h");
	app.handleInput("i");
	await waitFrame((f) => f.some((l) => l.includes("❯ hi▏")));
	assert.ok(
		has((f) => f.some((l) => l.includes("❯ hi▏"))),
		"编辑器内容入帧",
	);
	app.handleInput("\x7f");
	app.handleInput("\x7f");

	// @ 文件补全（工作区两个文件）→ Tab 接受
	app.handleInput("@");
	await waitFrame((f) => f.some((l) => l.includes("▸a.ts")));
	assert.ok(
		has((f) => f.some((l) => l.includes("▸a.ts"))),
		"文件候选出现",
	);
	app.handleInput("\t");
	assert.ok(
		app.editor.text.startsWith("@a.ts") || app.editor.text.startsWith("@note.md"),
		`接受候选：${app.editor.text}`,
	);
	app.handleInput(" ");
	app.handleInput("\x1b"); // Esc → 导航模式
	app.editor.clear(); // 清空本段演示输入（后续发送阶段从空开始）

	// 侧栏两段切换：会话页 → 文件页 → Enter 打开文件（中栏标签页）
	app.handleInput("t");
	await waitFrame((f) => f.some((l) => l.includes("会话")));
	app.handleInput("t");
	await waitFrame((f) => f.some((l) => l.includes("文件")));
	app.handleInput("\r"); // 打开选中文件（a.ts，行首）
	await waitFrame((f) => f.some((l) => l.includes("export const x = 1")));
	assert.equal(app.model.activeTabId, `file:${ws}/a.ts`);
	assert.ok(has((f) => f.some((l) => l.includes("note.md ×") === false && l.includes("a.ts ×"))));
	app.handleInput("x"); // 关闭文件页签
	assert.equal(app.model.activeTabId, "chat");

	// 输入模式发送 → daemon echo 事件入帧
	app.handleInput("i");
	for (const ch of "ping") app.handleInput(ch);
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => /echo\(\d+\): ping/.test(l)));
	assert.ok(
		has((f) => f.some((l) => /echo\(\d+\): ping/.test(l))),
		"发送后 echo 回复入帧",
	);
	assert.equal(app.editor.text, "", "发送后编辑器清空");

	// '\\' 行尾 + Enter → 换行不发送
	for (const ch of "l1 \\") app.handleInput(ch);
	app.handleInput("\r");
	assert.equal(app.editor.lines.length, 2, "反斜杠续行");
	app.handleInput("\x1b\r"); // Alt+Enter 再来一行
	assert.equal(app.editor.lines.length, 3, "Alt+Enter 换行");
	app.editor.clear();
	app.handleInput("\x1b");

	// 权限弹窗：daemon 广播 → 帧 → y 应答
	const answerP = core.requestPermission(
		{ privilege: "write", reason: "写 /etc/hosts", detail: { tool: "write", targetPath: "/etc/hosts", mode: "C" } },
		3000,
	);
	await waitFrame((f) => f.some((l) => l.includes("[y] 允许一次")));
	assert.ok(
		has((f) => f.some((l) => l.includes("权限申请：write"))),
		"权限弹窗入帧",
	);
	app.handleInput("y");
	assert.deepEqual(await answerP, { approved: true, scope: "once" });
	await waitFrame((f) => !f.some((l) => l.includes("[y] 允许一次")));

	// 合并确认弹窗：d → discard 回调
	let applied = false;
	let discarded = false;
	app.openMergeConfirm([{ path: "src/a.ts", status: "M" }], "wt-1", {
		onApply: () => {
			applied = true;
		},
		onDiscard: () => {
			discarded = true;
		},
	});
	await waitFrame((f) => f.some((l) => l.includes("[Enter] apply")));
	app.handleInput("d");
	assert.equal(applied, false);
	assert.equal(discarded, true);

	setup.close();
});

// —— 差分渲染证据：小变更的增量输出远小于整帧 ——

class CountingTerminal implements Terminal {
	private readonly inner: Terminal;
	bytes = 0;

	constructor(inner: Terminal) {
		this.inner = inner;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
		this.inner.stop();
	}

	write(data: string): void {
		this.bytes += data.length;
		this.inner.write(data);
	}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}
}

test("差分渲染：单字符变更的写出量远小于整帧（Screen 行差分）", async () => {
	const home = newDir();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const setup = new RpcClient();
	await setup.connect(core.socketPath());
	const { sessionId } = await setup.request<{ sessionId: string }>(Methods.sessionNew, {
		workspace: null,
	});

	const vt = new VirtualTerminal(110, 32);
	const counting = new CountingTerminal(vt);
	const frames: string[][] = [];
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const app = new PondaTui({
		env: "web",
		home,
		client,
		terminal: counting,
		pollMs: 60000,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
	});
	apps.push(app);
	await app.start(sessionId);
	for (let i = 0; i < 100 && frames.length === 0; i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	const fullFrameChars = (frames[0] ?? []).reduce((a, l) => a + l.length + 2, 0);
	assert.ok(fullFrameChars > 1000, `整帧应有足够体量：${fullFrameChars}`);

	// 进入输入模式（布局已稳定）后再度量单字符变更
	app.handleInput("i");
	for (let i = 0; i < 50 && frames.length < 2; i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	const bytesBefore = counting.bytes;
	app.handleInput("x");
	for (let i = 0; i < 50 && frames.length < 3; i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	const delta = counting.bytes - bytesBefore;
	assert.ok(delta < fullFrameChars * 0.25, `增量写出 ${delta} 应远小于整帧 ${fullFrameChars}`);
	setup.close();
});
