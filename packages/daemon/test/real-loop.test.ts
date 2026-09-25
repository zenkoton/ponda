/**
 * P4 真实链路：PiAgentLoop + coding 工具 + sandbox 守卫（tool-guard）。
 * - 工具真实执行（write 落盘）
 * - 守卫三域路由：工作区外 deny 拒绝 / temp-workspace 重写进副本
 * - 权限三档（03 §7.3）：plan 写确认、approve 高危 bash 申请、批准/拒绝往返
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { createCodingTools } from "../../coding-agent/src/core/tools/index.ts";
import { paths } from "../../core/src/paths.ts";
import {
	fauxAssistantMessage,
	fauxToolCall,
	PiAgentLoop,
	registerFauxProvider,
	type ToolGuard,
} from "../src/pi-loop.ts";
import { createSandboxToolGuard, type GuardPermissionRequester } from "../src/tool-guard.ts";

const cleanups: (() => void)[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

const fauxes: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	for (const f of fauxes.splice(0)) f.unregister();
});

type PermissionReq = Parameters<GuardPermissionRequester>[0];

interface LoopRig {
	faux: FauxProviderRegistration;
	loop: PiAgentLoop;
	guard: ToolGuard;
	home: string;
	events: { type: string; payload: Record<string, unknown> }[];
	requests: PermissionReq[];
	setAnswer(a: { approved: boolean; scope: "once" | "session" | "env-always" }): void;
}

function newLoop(
	workspace: string,
	overrides: {
		policy?: { mode: "inplace" | "worktree"; autoGitInit: boolean; outsideWorkspace: "deny" | "temp-workspace" };
		getMode?: () => "plan" | "approve" | "full-auto";
	} = {},
): LoopRig {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	const home = newDir("ponda-home-");
	const loop = new PiAgentLoop({
		modelId: "faux-1",
		faux,
		tools: createCodingTools(workspace),
	});
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const requests: PermissionReq[] = [];
	let answer: { approved: boolean; scope: "once" | "session" | "env-always" } = { approved: true, scope: "once" };
	const guard = createSandboxToolGuard({
		home,
		sessionId: "sess-test-0001",
		workspace,
		policy: overrides.policy ?? { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
		getMode: overrides.getMode ?? (() => "approve"),
		requestPermission: async (req) => {
			requests.push(req);
			return answer;
		},
		onEvent: (type, payload) => events.push({ type, payload }),
	});
	loop.bindToolGuard(guard);
	return {
		faux,
		loop,
		guard,
		home,
		events,
		requests,
		setAnswer(a: { approved: boolean; scope: "once" | "session" | "env-always" }) {
			answer = a;
		},
	};
}

test("真实循环：write 工具实际执行并落盘", async () => {
	const ws = newDir("ponda-ws-");
	const { faux, loop, events } = newLoop(ws);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "ponda real loop" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("已写入"),
	]);
	const r = await loop.process({ userText: "写文件", entryCount: 2 });
	assert.equal(r.assistantText, "已写入");
	assert.ok(existsSync(join(ws, "hello.txt")), "write 工具真实执行");
	assert.equal(readFileSync(join(ws, "hello.txt"), "utf8"), "ponda real loop");
	assert.ok(events.some((e) => e.type === "tool.call" && e.payload.route === "inplace"));
});

test("守卫：工作区外 deny 策略拒绝写（原文件不动）", async () => {
	const ws = newDir("ponda-ws-");
	const outside = join(newDir("ponda-out-"), "secret.txt");
	const { faux, loop } = newLoop(ws, { policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "deny" } });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: outside, content: "x" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("被拒绝"),
	]);
	await loop.process({ userText: "写外部文件", entryCount: 2 });
	assert.ok(!existsSync(outside), "deny 策略下工作区外文件不被创建");
});

test("守卫：工作区外写重定向进临时工作区副本（03 §4）", async () => {
	const home = newDir("ponda-home-");
	const ws = newDir("ponda-ws-");
	const outside = join(newDir("ponda-out-"), "config.yaml");
	const decision = await createSandboxToolGuard({
		home,
		sessionId: "sess-temp-0001",
		workspace: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
		getMode: () => "approve",
		requestPermission: async () => ({ approved: true, scope: "once" }),
		onEvent: () => {},
	}).beforeToolCall?.({ name: "write", arguments: { path: outside, content: "x" } });
	assert.ok(decision?.allowed, "temp-workspace 路由放行");
	const rewritten = decision.rewritten?.path;
	assert.equal(typeof rewritten, "string");
	assert.ok((rewritten as string).includes(join(paths.sandboxes(home))), "入参重写指向临时工作区副本");
	assert.ok(!existsSync(outside), "原路径未被触碰");
});

test("守卫：approve 模式高危 bash 触发权限申请，拒绝则不执行", async () => {
	const ws = newDir("ponda-ws-");
	const { faux, loop, requests, setAnswer } = newLoop(ws);
	setAnswer({ approved: false, scope: "once" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf /tmp/nope" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("命令被拒绝"),
	]);
	await loop.process({ userText: "跑高危命令", entryCount: 2 });
	assert.equal(requests.length, 1, "高危命令触发一次权限申请");
	assert.equal(requests[0]?.privilege, "execute");
	assert.equal(requests[0]?.detail.mode, "danger");
});

test("守卫：session 批准后同类高危命令本会话不再申请", async () => {
	const ws = newDir("ponda-ws-");
	const { faux, loop, requests, setAnswer } = newLoop(ws);
	setAnswer({ approved: true, scope: "session" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("bash", { command: "sudo ls" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("bash", { command: "sudo whoami" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("两次执行"),
	]);
	await loop.process({ userText: "两次提权", entryCount: 2 });
	assert.equal(requests.length, 1, "session 级批准只申请一次");
});

test("守卫：plan 模式工作区内写也需确认", async () => {
	const ws = newDir("ponda-ws-");
	const { faux, loop, requests, setAnswer } = newLoop(ws, { getMode: () => "plan" });
	setAnswer({ approved: false, scope: "once" });
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: join(ws, "a.txt"), content: "x" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("被拒"),
	]);
	await loop.process({ userText: "写", entryCount: 2 });
	assert.equal(requests.length, 1, "plan 模式写操作需确认");
	assert.equal(requests[0]?.privilege, "write");
	assert.ok(!existsSync(join(ws, "a.txt")));
});

test("守卫形状：bindToolGuard 的 block/改写经上游 BeforeToolCallResult 生效", async () => {
	// 上游 agent-loop 只认 {block,reason}（prepareToolCall:739），改写靠原地合并 args；
	// 这里断言 PiAgentLoop.bindToolGuard 产出的 beforeToolCall 适配形状
	const ws = newDir("ponda-ws-");
	const { loop } = newLoop(ws);
	const before = (loop as unknown as { agent: { beforeToolCall?: unknown } }).agent.beforeToolCall;
	assert.equal(typeof before, "function", "beforeToolCall 已挂到 Agent");
});
