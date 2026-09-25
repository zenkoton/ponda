/**
 * 模型工具面（design: 05 §2.2 / §6.2 / 02 §7）：
 * todo_write/todo_read、spawn_subagent/swarm_status/send_message/cancel_subagent、
 * memory_write 经 PiAgentLoop 真实执行（faux 脚本化工具调用）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { paths } from "../../core/src/paths.ts";
import { ScriptedAgentLoop } from "../src/agent-loop.ts";
import { agentToolsSystemPrompt, createMemoryTool, createSwarmTools, createTodoTools } from "../src/agent-tools.ts";
import { fauxAssistantMessage, fauxToolCall, PiAgentLoop, registerFauxProvider } from "../src/pi-loop.ts";
import { SessionManager } from "../src/sessions.ts";
import { SwarmRuntime } from "../src/swarm.ts";
import { TodoRuntime } from "../src/todo.ts";

const cleanups: (() => void)[] = [];
const fauxes: FauxProviderRegistration[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	for (const f of fauxes.splice(0)) f.unregister();
});

test("todo_write/todo_read：模型调用真实落看板（05 §2.2）", async () => {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const todos = new TodoRuntime();
	const loop = new PiAgentLoop({
		modelId: "faux-1",
		faux,
		tools: createTodoTools(todos, () => "task-1"),
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("todo_write", {
					ops: [
						{ op: "add", id: "t1", text: "分析代码" },
						{ op: "add", id: "t2", text: "写补丁", status: "pending" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("看板已建立"),
	]);
	await loop.process({ userText: "开始", entryCount: 2 });
	const board = todos.read("task-1");
	assert.equal(board.items.length, 2);
	assert.equal(board.items[0]?.text, "分析代码");

	// todo_read 工具面
	const readBack = await createTodoTools(todos, () => "task-1")[1]?.execute?.("x", {});
	assert.ok(JSON.stringify(readBack).includes("分析代码"));
});

test("memory_write：追加环境记忆 MEMORY.md（02 §7）", async () => {
	const home = newDir("ponda-at-");
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const loop = new PiAgentLoop({
		modelId: "faux-1",
		faux,
		tools: [createMemoryTool(home, "web")],
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("memory_write", { content: "构建走 npm run check" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("已记住"),
	]);
	await loop.process({ userText: "go", entryCount: 2 });
	const memFile = join(paths.env(home, "web"), "memory", "MEMORY.md");
	assert.ok(existsSync(memFile), "MEMORY.md 落盘");
	assert.ok(readFileSync(memFile, "utf8").includes("构建走 npm run check"));
});

test("spawn_subagent：模型可创建子 agent 并经 swarm_status 观察（05 §6）", async () => {
	const home = newDir("ponda-at-");
	const ws = newDir("ponda-at-ws-");
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const sessions = new SessionManager(home, "web", new ScriptedAgentLoop([]));
	const swarm = new SwarmRuntime({ sessions, loopFor: () => new ScriptedAgentLoop(["done"]) });
	const tools = createSwarmTools(swarm, () => ws);
	const loop = new PiAgentLoop({
		modelId: "faux-1",
		faux,
		tools,
	});
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("spawn_subagent", { role: "explorer", brief: "摸清结构" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("子 agent 已派出"),
	]);
	await loop.process({ userText: "分工", entryCount: 2 });
	assert.equal(swarm.status().cells.length, 1, "cell 已创建");
	assert.equal(swarm.status().cells[0]?.role, "explorer");
});

test("agentToolsSystemPrompt：包含分解纪律与 swarm 用法段", () => {
	const p = agentToolsSystemPrompt();
	assert.ok(p.includes("todo_write"));
	assert.ok(p.includes("spawn_subagent"));
	assert.ok(p.includes("memory_write"));
});
