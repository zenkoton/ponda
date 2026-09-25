/**
 * TUI 输入区状态行（design: 04 §5.4）：mode/思考强度/模型/上下文占用显示、
 * 超 80% 警示 /compact、^x p 循环切换权限模式（03 §7.3，daemon 会话级事实源）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { DaemonCore } from "../../daemon/src/core.ts";
import { registerFauxProvider } from "../../daemon/src/pi-loop.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { renderStateFrame } from "../../tui-next/src/app/components.ts";
import { createTuiState } from "../../tui-next/src/app/state.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
function newHome2(): string {
	return newDir("ponda-sl2-");
}
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

test("状态行渲染：mode/think/model/ctx 占比 + 超 80% 警示 /compact", () => {
	const state = createTuiState("web");
	state.setStatusLine({
		mode: "approve",
		thinking: "off",
		modelId: "faux-1",
		ctxUsed: 12000,
		ctxWindow: 200000,
	});
	const normal = renderStateFrame(state, 110, 30).map(stripAnsi).join("\n");
	assert.ok(normal.includes("mode: approve"), "mode 显示");
	assert.ok(normal.includes("think: off"), "思考强度显示");
	assert.ok(normal.includes("model: faux-1"), "模型显示");
	assert.ok(normal.includes("12.0k/200.0k"), `ctx 占用显示：${normal.split("\n").find((l) => l.includes("ctx"))}`);
	assert.ok(!normal.includes("/compact"), "未超限不提示");

	state.setStatusLine({ ...state.statusLine(), ctxUsed: 180000 });
	const warn = renderStateFrame(state, 110, 30).map(stripAnsi).join("\n");
	assert.ok(warn.includes("/compact"), "超 80% 提示 /compact");
	assert.ok(warn.includes("90%"), "占比更新");
});

test("状态行端到端：真实 PiAgentLoop 的 runtimeInfo 入帧 + ^x p 循环切换", async () => {
	const home = newDir("ponda-sl-");
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();

	const client = new RpcClient();
	await client.connect(core.socketPath());
	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: home });

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
	await app.start(created.sessionId);
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	const waitFrame = async (pred: (l: string) => boolean, ms = 3000): Promise<boolean> => {
		for (let i = 0; i < ms / 20; i++) {
			if (seen(pred)) return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen(pred);
	};

	// 状态行显示 daemon 侧事实（真实循环的 model/thinking）
	assert.ok(await waitFrame((l) => l.includes("mode: approve") && l.includes("model:")), "状态行入帧（mode + model）");

	// ^x p：approve → full-auto（leader 前缀键）
	app.handleInput("\x18"); // ctrl+x
	app.handleInput("p");
	assert.ok(await waitFrame((l) => l.includes("mode: full-auto")), "循环切到 full-auto");
	assert.equal(core.sessionMode(created.sessionId), "full-auto", "daemon 会话模式已切换");

	// 再切一次 → plan
	app.handleInput("\x18");
	app.handleInput("p");
	assert.ok(await waitFrame((l) => l.includes("mode: plan")), "再切到 plan");
	assert.equal(core.sessionMode(created.sessionId), "plan");
});

test("思考强度循环：^x ctrl+t 经 RPC 切换 daemon 侧 thinkingLevel", async () => {
	const home = newHome2();
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: home });

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
	await app.start(created.sessionId);
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	const waitFrame = async (pred: (l: string) => boolean, ms = 3000): Promise<boolean> => {
		for (let i = 0; i < ms / 20; i++) {
			if (seen(pred)) return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen(pred);
	};
	await waitFrame(() => true);
	app.handleInput("\x18"); // ctrl+x
	app.handleInput("\x14"); // ctrl+t
	assert.ok(await waitFrame((l) => l.includes("think: low")), "切到 low");
	const info = await client.request<{ runtime: { thinkingLevel: string } | null }>(Methods.sessionInfo, {
		sessionId: created.sessionId,
	});
	assert.equal(info.runtime?.thinkingLevel, "low", "daemon 侧已切换");
});
