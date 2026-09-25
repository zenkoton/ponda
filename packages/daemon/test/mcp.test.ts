/**
 * MCP 客户端（design: 02 §4 mcp-server / 00 §1.1）：
 * - McpClient：initialize 握手 / tools/list / tools/call（ndjson JSON-RPC over stdio）
 * - daemon 集成：envs/<env>/mcp.json 声明的 server 工具注入 PiAgentLoop 工具面
 *   （faux 脚本调用 mcp__echo-server__echo → 真实经 MCP 子进程执行）
 * - 失败 server 降级不阻塞 daemon
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";
import { loadMcpTools, McpClient } from "../src/mcp.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../src/pi-loop.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ECHO_MCP = join(__dirname, "fixtures", "echo-mcp.mjs");

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const fauxes: FauxProviderRegistration[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const f of fauxes.splice(0)) f.unregister();
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("McpClient：握手 / 工具包装 / tools/call 真实执行", async () => {
	const client = new McpClient("echo-server", { command: process.execPath, args: [ECHO_MCP] });
	try {
		await client.start();
		const tools = await client.agentTools();
		assert.equal(tools.length, 1, "echo 工具被发现");
		assert.equal(tools[0]?.name, "mcp__echo-server__echo");
		const result = await tools[0]?.execute("t1", { text: "ponda mcp" });
		assert.ok(JSON.stringify(result).includes("echo: ponda mcp"), "调用经 MCP 子进程执行");
	} finally {
		client.stop();
	}
});

test("loadMcpTools：失败 server 降级记录，不阻塞", async () => {
	const home = newDir("ponda-mcp-");
	const envDir = join(home, "envs", "web");
	mkdirSync(envDir, { recursive: true });
	writeFileSync(
		join(envDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				good: { command: process.execPath, args: [ECHO_MCP] },
				bad: { command: "/nonexistent/mcp-server-bin" },
			},
		}),
	);
	const r = await loadMcpTools(home, "web");
	try {
		assert.equal(r.tools.length, 1, "好 server 的工具就位");
		assert.ok(
			r.warnings.some((w) => w.includes('"bad"')),
			`坏 server 降级记录：${r.warnings.join(";")}`,
		);
	} finally {
		for (const c of r.clients) c.stop();
	}
});

test("daemon 集成：mcp.json 工具注入会话工具面（per-env MCP 隔离落到运行时）", async () => {
	const home = newDir("ponda-mcp2-");
	const ws = newDir("ponda-mcp2-ws-");
	const envDir = join(home, "envs", "web");
	mkdirSync(envDir, { recursive: true });
	writeFileSync(
		join(envDir, "mcp.json"),
		JSON.stringify({ mcpServers: { "echo-server": { command: process.execPath, args: [ECHO_MCP] } } }),
	);

	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("mcp__echo-server__echo", { text: "runtime mcp" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("MCP 工具已调用"),
	]);

	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();
	assert.equal(core.mcpTools.length, 1, "daemon 加载 mcp 工具");

	const c = new RpcClient();
	await c.connect(core.socketPath());
	const created = await c.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });
	await c.request(Methods.sessionSend, { sessionId: created.sessionId, text: "调 MCP 工具" });
	for (let i = 0; i < 200; i++) {
		const l = await c.request<{ processing: boolean }[]>(Methods.sessionList);
		if (l[0]?.processing === false) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	// 会话流中出现工具执行条目，且为成功
	const jsonl = readFileSync(join(envDir, "sessions", `${created.sessionId}.jsonl`), "utf8");
	assert.ok(jsonl.includes("mcp__echo-server__echo"), "MCP 工具调用入会话流");
	const toolLine = jsonl.split("\n").find((l) => l.includes("mcp__echo-server__echo") && l.includes("ponda.tool"));
	assert.ok(toolLine !== undefined);
	assert.ok(toolLine.includes('"ok":true'), "MCP 调用成功");
});
