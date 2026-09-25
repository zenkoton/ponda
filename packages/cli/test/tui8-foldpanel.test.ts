/**
 * TUI 工具折叠（04 §5.3：▸ tool（✔/✘ s）、失败红色、>5 同类聚合 N×）
 * 与右栏三段（04 §4.3：TODOLIST 进度条 + 成果状态 + 权限通知段）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("工具折叠：真实工具执行落会话流并渲染 ▸ 行（成功 ✔ / 失败 ✘）", async () => {
	const home = newDir("ponda-fold-");
	const ws = newDir("ponda-fold-ws-");
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessageToolCalls([
			["write", { path: "ok.txt", content: "x" }],
			["bash", { command: "exit 7" }],
		]),
		fauxAssistantMessage("两次工具都已执行"),
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
	await client.request(Methods.sessionSend, { sessionId: created.sessionId, text: "跑工具" });

	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	const waitFrame = async (pred: (l: string) => boolean, ms = 5000): Promise<boolean> => {
		for (let i = 0; i < ms / 20; i++) {
			if (seen(pred)) return true;
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen(pred);
	};

	assert.ok(await waitFrame((l) => l.includes("两次工具都已执行")), "最终回复到达");
	const flat = frames.flat().join("\n");
	assert.ok(flat.includes("▸ write") && flat.includes("✔"), "成功工具折叠行（✔）");
	assert.ok(flat.includes("▸ bash") && flat.includes("✘"), "失败工具折叠行（✘）");

	// 会话 JSONL 中存在 ponda.tool 条目（TUI 数据源即会话流，attach 重放可见）
	const jsonl = readFileSync(join(home, "envs", "web", "sessions", `${created.sessionId}.jsonl`), "utf8");
	assert.ok(jsonl.includes('"ponda.tool"'), "工具条目落会话流");
	assert.ok(jsonl.includes('"ok":false'), "失败标记落盘");
});

test("工具聚合：连续同类 >5 条折叠为 N× 行", async () => {
	const home = newDir("ponda-fold2-");
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: home });
	for (let i = 0; i < 6; i++) {
		core.appendToolEntry(created.sessionId, {
			name: "edit",
			argsDigest: `{"path":"f${i}"}`,
			ok: true,
			durationMs: 5,
		});
	}
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
	for (let i = 0; i < 150; i++) {
		if (seen((l) => l.includes("6× edit"))) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		seen((l) => l.includes("6× edit")),
		"同类 6 条聚合为 6× edit",
	);
	assert.ok(!seen((l) => l.includes("▸ edit {")), "组内条目被吸收不逐条渲染");
});

test("右栏 TODOLIST 段：todo.write 后出现进度条与条目", async () => {
	const home = newDir("ponda-todop-");
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: home });
	await client.request(Methods.todoWrite, {
		taskId: "session",
		ops: [
			{ op: "add", id: "t1", text: "分析代码" },
			{ op: "add", id: "t2", text: "写补丁", status: "done" },
			{ op: "add", id: "t3", text: "跑测试", status: "in_progress" },
		],
	});

	const term = new VirtualTerminal(110, 34);
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
	await app.start(created.sessionId);
	const seen = (pred: (l: string) => boolean): boolean => frames.some((f) => f.some(pred));
	for (let i = 0; i < 150; i++) {
		if (seen((l) => l.includes("TODO") && l.includes("1/3"))) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(
		seen((l) => l.includes("TODO")),
		"TODO 段出现",
	);
	assert.ok(
		seen((l) => l.includes("1/3")),
		"进度计数 1/3",
	);
	assert.ok(
		seen((l) => l.includes("◐ t3")),
		"进行中条目标记",
	);
	assert.ok(
		seen((l) => l.includes("通知")),
		"第 3 段（权限/通知）出现",
	);
});

/** faux 多工具调用消息（本测试局部助手） */
function fauxAssistantMessageToolCalls(
	calls: [string, Record<string, string>][],
): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage(
		calls.map(([name, args]) => fauxToolCall(name, args)),
		{ stopReason: "toolUse" },
	);
}
