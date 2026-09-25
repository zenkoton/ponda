import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
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
	const d = mkdtempSync(join(tmpdir(), "ponda-m9-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("TUI @ 补全包含 .wiki 页面（08 §4 / 04 §4.2）", async () => {
	const home = newDir();
	const ws = newDir();
	mkdirSync(join(ws, "src"), { recursive: true });
	writeFileSync(join(ws, "src", "auth.ts"), "// auth\n");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c1"], { cwd: ws });

	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const ctl = new RpcClient();
	await ctl.connect(core.socketPath());
	await ctl.request(Methods.wikiBuild, {
		workspace: ws,
		moduleBody: "auth 模块知识页",
	});

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

	// 会话绑定工作区（文件树/补全源）后输入 @：用带工作区的会话重启 app
	const created = await ctl.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });
	await app.stop();
	const app2 = new PondaTui({
		env: "web",
		home,
		client,
		terminal: term,
		pollMs: 60000,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
	});
	apps.push(app2);
	await app2.start(created.sessionId);
	app2.handleInput("@");
	await waitFrame((f) => f.some((l) => l.includes(".wiki/modules/src.md")));
	assert.ok(
		has((f) => f.some((l) => l.includes(".wiki/modules/src.md"))),
		".wiki 页面进入候选",
	);

	// Tab 接受 → 编辑器含 .wiki 路径
	app2.handleInput("\t");
	assert.ok(app2.editor.text.startsWith("@.wiki/"), `接受候选（.wiki 页面）：${app2.editor.text}`);
	ctl.close();
});
