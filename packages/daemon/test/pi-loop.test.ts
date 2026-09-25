import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../../core/src/paths.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, Notifications } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";
import { fauxAssistantMessage, fauxText, fauxThinking, registerFauxProvider } from "../src/pi-loop.ts";

/**
 * P4 端到端：daemon 会话经真实 pi-agent-core Agent 循环驱动。
 * faux provider 脚本化模型响应（与上游 agent 包 e2e 同一测试基建）；
 * 验证：session.send → Agent.prompt → assistant 回复入帧/入文件、
 * usage 累计、多轮上下文、swarm cell 同走真实循环。
 */
const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const fauxes: { unregister(): void }[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-p4-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(async () => {
	for (const f of fauxes.splice(0)) f.unregister();
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("P4 e2e：session.send 经 pi-agent-core Agent 循环 → 回复/usage/多轮上下文", async () => {
	const home = newHome();
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessage([fauxThinking("先分析"), fauxText("第一轮：答案是 4")]),
		fauxAssistantMessage("第二轮：是的，4"),
	]);

	const core = new DaemonCore({
		home,
		env: "web",
		piModel: { modelId: "faux-1", systemPrompt: "You are a test agent.", faux },
	});
	cores.push(core);
	await core.start();

	const c = new RpcClient();
	await c.connect(core.socketPath());
	const events: { sessionId: string; event: { kind: string; line?: string } }[] = [];
	c.setNotificationHandler((n) => {
		if (n.method === Notifications.sessionEvents) {
			events.push(n.params as { sessionId: string; event: { kind: string; line?: string } });
		}
	});

	// 第一轮（attach 后才接收 session.events）
	const created = await c.request<{ sessionId: string }>(Methods.sessionNew, { workspace: null });
	const { sessionId } = created;
	await c.request(Methods.sessionAttach, { sessionId });
	await c.request(Methods.sessionSend, { sessionId, text: "What is 2+2?" });

	// 等 assistant 条目（真实 Agent 循环完成）
	for (let i = 0; i < 150; i++) {
		const list = await c.request<{ processing: boolean; entryCount: number }[]>(Methods.sessionList);
		if (list[0]?.processing === false && (list[0]?.entryCount ?? 0) >= 3) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const list1 = await c.request<{ tokens: { input: number; output: number }; entryCount: number; costUsd: number }[]>(
		Methods.sessionList,
	);
	assert.ok((list1[0]?.tokens.input ?? 0) > 0, `真实 usage 已累计：${JSON.stringify(list1[0]?.tokens)}`);
	assert.equal(list1[0]?.entryCount, 3); // header + user + assistant

	// 会话文件含 assistant 输出（pi 格式）
	const file = join(paths.env(home, "web"), "sessions", `${sessionId}.jsonl`);
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	const assistantEntry = JSON.parse(lines[2] ?? "{}") as {
		message?: { role?: string; content?: { type: string; text?: string }[] };
	};
	assert.equal(assistantEntry.message?.role, "assistant");
	const texts = (assistantEntry.message?.content ?? []).filter((b) => b.type === "text");
	assert.ok(texts[0]?.text?.includes("第一轮：答案是 4"));

	// 第二轮：多轮上下文（Agent 实例保持，usage 累计）
	await c.request(Methods.sessionSend, { sessionId, text: "确定吗？" });
	for (let i = 0; i < 150; i++) {
		const list = await c.request<{ processing: boolean; entryCount: number }[]>(Methods.sessionList);
		if (list[0]?.processing === false && (list[0]?.entryCount ?? 0) >= 5) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const list2 = await c.request<{ entryCount: number; tokens: { input: number } }[]>(Methods.sessionList);
	assert.equal(list2[0]?.entryCount, 5);
	assert.ok((list2[0]?.tokens.input ?? 0) > (list1[0]?.tokens.input ?? 0), "多轮 usage 增长");

	// 事件流包含条目
	assert.ok(events.some((e) => e.event.kind === "entry"));
	c.close();
});

test("P4 e2e：swarm cell 同走真实 agent 循环", async () => {
	const home = newHome();
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([fauxAssistantMessage("swarm cell 经 pi 循环回复")]);

	const core = new DaemonCore({
		home,
		env: "web",
		piModel: { modelId: "faux-1", faux },
	});
	cores.push(core);
	await core.start();

	const c = new RpcClient();
	await c.connect(core.socketPath());
	await c.request<{ cellId: string; sessionId: string }>(Methods.swarmSpawn, {
		role: "实现者",
		brief: "do it",
	});

	for (let i = 0; i < 150; i++) {
		const st = await c.request<{ cells: { status: string; lastResult: string | null }[] }>(Methods.swarmStatus);
		if (st.cells[0]?.status === "done") break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const st = await c.request<{ cells: { status: string; lastResult: string | null; costUsd: number }[] }>(
		Methods.swarmStatus,
	);
	assert.equal(st.cells[0]?.status, "done");
	assert.ok((st.cells[0]?.lastResult ?? "").includes("pi 循环回复"), `结果：${st.cells[0]?.lastResult}`);
	assert.ok((st.cells[0]?.costUsd ?? 0) >= 0);
	c.close();
});
