/** TUI /undo（PM 对标项：撤销入口）：快照链回滚最近一轮，确认弹窗 Enter 应用 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { DaemonCore } from "../../daemon/src/core.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../../daemon/src/pi-loop.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
const fauxes: FauxProviderRegistration[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const f of fauxes.splice(0)) f.unregister();
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("/undo 端到端：修改 → 快照 → /undo 确认弹窗 → Enter 回滚", async () => {
	const home = newDir("ponda-undo-");
	const ws = newDir("ponda-undo-ws-");
	writeFileSync(join(ws, "seed.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: ws });

	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("edit", { path: "seed.txt", oldText: "base", newText: "changed" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("已修改"),
	]);
	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });

	const term = new VirtualTerminal(110, 34);
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
	await app.start(created.sessionId);
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	const waitFrame = async (pred: (l: string) => boolean, ms = 5000): Promise<boolean> => {
		for (let i = 0; i < ms / 20; i++) {
			if (seen(pred)) return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen(pred);
	};

	// 修改经真实工具执行 → 快照链建立
	await client.request(Methods.sessionSend, { sessionId: created.sessionId, text: "改文件" });
	assert.ok(await waitFrame((l) => l.includes("已修改")), "修改完成");
	assert.equal(readFileSync(join(ws, "seed.txt"), "utf8").includes("changed"), true, "工作区已修改");

	// /undo → 确认弹窗
	for (const ch of "/undo") app.handleInput(ch);
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("撤销最近一轮修改")), "确认弹窗出现");
	// Enter 应用回滚
	app.handleInput("\r");
	assert.ok(await waitFrame((l) => l.includes("已撤销最近一轮修改")), "回滚完成通知");

	// seed.txt 回到 base（已跟踪文件 reset --hard 语义）
	assert.equal(readFileSync(join(ws, "seed.txt"), "utf8"), "base\n", "内容已回滚");
	// 快照链保留（仍可 snapshots 查看）
	const st = await client.request<{ activity: { turns: number } | null }>(Methods.sandboxStatus, {
		sessionId: created.sessionId,
	});
	assert.ok((st.activity?.turns ?? 0) >= 1, "快照链保留");
	void existsSync;
});
