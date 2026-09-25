import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui/src/ponda/app.ts";
import { computeCompletion, renderCompletionPopup } from "../../tui/src/ponda/completion.ts";
import { compositeDialog, type MergeConfirmState } from "../../tui/src/ponda/dialogs.ts";
import { PondaEditor } from "../../tui/src/ponda/editor.ts";
import { listFileCandidates, newFileTreeState, readFilePreview, scanTree } from "../../tui/src/ponda/files.ts";
import { closeTab, cycleTab, newReadModel, openFileTab } from "../../tui/src/ponda/model.ts";
import { stripAnsi } from "../../tui/src/ponda/view.ts";
import type { Terminal } from "../../tui/src/terminal.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

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

	const st = newFileTreeState();
	let nodes = scanTree(ws, st.expanded);
	assert.deepEqual(
		nodes.map((n) => n.relPath),
		["root.txt", "src"],
		"默认折叠仅顶层，node_modules 被忽略",
	);
	st.expanded.add("src");
	nodes = scanTree(ws, st.expanded);
	assert.deepEqual(
		nodes.map((n) => n.relPath),
		["root.txt", "src", "src/a.ts", "src/sub"],
	);
	st.expanded.add("src/sub");
	nodes = scanTree(ws, st.expanded);
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

// —— 弹窗 ——

test("compositeDialog：权限/合并弹窗居中覆盖帧", () => {
	const frame = Array.from({ length: 24 }, (_, i) => `row-${i}`.padEnd(100));
	const withDialog = compositeDialog(frame, {
		kind: "permission",
		requestId: "p1",
		privilege: "write",
		reason: "写工作区外文件 /etc/hosts",
		detail: { tool: "write", targetPath: "/etc/hosts", mode: "C" },
	});
	assert.equal(withDialog.length, frame.length);
	assert.ok(withDialog.some((l) => l.includes("权限申请：write")));
	assert.ok(withDialog.some((l) => l.includes("/etc/hosts")));
	assert.ok(withDialog.some((l) => l.includes("[a] 总是允许")));
	assert.ok(withDialog.some((l) => l.includes("┌")));
	assert.ok(withDialog.some((l) => l.includes("└")));

	const merge: MergeConfirmState = {
		kind: "merge",
		files: [
			{ path: "src/a.ts", status: "M" },
			{ path: "src/new.ts", status: "A" },
		],
		note: "worktree wt-1 结算",
	};
	const m = compositeDialog(frame, merge);
	assert.ok(m.some((l) => l.includes("src/a.ts")));
	assert.ok(m.some((l) => l.includes("wt-1")));
	assert.ok(m.some((l) => l.includes("[Enter] apply")));
});

// —— 页签模型 ——

test("openFileTab/closeTab/cycleTab", () => {
	const m = newReadModel("web");
	openFileTab(m, "/w/a.ts", "a.ts");
	openFileTab(m, "/w/b.md", "b.md");
	assert.equal(m.centerTabs.length, 3);
	assert.equal(m.activeTabId, "file:/w/b.md");
	openFileTab(m, "/w/a.ts", "a.ts"); // 已存在 → 激活不重复
	assert.equal(m.centerTabs.length, 3);
	assert.equal(m.activeTabId, "file:/w/a.ts");
	cycleTab(m, 1);
	assert.equal(m.activeTabId, "file:/w/b.md");
	cycleTab(m, 1); // 回到 chat
	assert.equal(m.activeTabId, "chat");
	closeTab(m, "file:/w/a.ts");
	assert.equal(m.centerTabs.length, 2);
	const chat = m.centerTabs[0];
	assert.ok(chat?.kind === "chat");
	closeTab(m, chat.id); // 主会话页不可关（忽略语义）
	assert.equal(m.centerTabs.length, 2);
	assert.equal(m.activeTabId, "chat");
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

	// 输入模式 + 编辑器内容入帧
	await waitFrame(() => true);
	app.handleInput("h");
	app.handleInput("i");
	await waitFrame((f) => f.some((l) => l.includes("❯▏hi")));
	assert.ok(
		has((f) => f.some((l) => l.includes("❯▏hi"))),
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
	app.handleInput("\x1b"); // 退出输入模式
	app.editor.clear(); // 清空本段演示输入（后续发送阶段从空开始）

	// 左栏文件页签 → 打开文件 → 中栏标签页内容
	app.handleInput("t");
	await waitFrame((f) => f.some((l) => l.includes("[文件]") && l.includes("▸ a.ts") === false && l.includes(" a.ts")));
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
	async drainInput(maxMs?: number, idleMs?: number): Promise<void> {
		await this.inner.drainInput(maxMs, idleMs);
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
	get kittyProtocolActive(): boolean {
		return this.inner.kittyProtocolActive;
	}
	moveBy(lines: number): void {
		this.inner.moveBy(lines);
	}
	hideCursor(): void {
		this.inner.hideCursor();
	}
	showCursor(): void {
		this.inner.showCursor();
	}
	clearLine(): void {
		this.inner.clearLine();
	}
	clearFromCursor(): void {
		this.inner.clearFromCursor();
	}
	clearScreen(): void {
		this.inner.clearScreen();
	}
	setTitle(title: string): void {
		this.inner.setTitle(title);
	}
	setProgress(active: boolean): void {
		this.inner.setProgress(active);
	}
}

test("差分渲染：单字符变更的写出量远小于整帧（TuiMainScreen diff）", async () => {
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
