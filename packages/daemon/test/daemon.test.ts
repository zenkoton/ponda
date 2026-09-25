import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../../core/src/paths.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, Notifications, type SessionEvent } from "../../rpc/src/index.ts";
import { ScriptedAgentLoop } from "../src/agent-loop.ts";
import { DaemonCore } from "../src/core.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-dmn-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(async () => {
	for (const c of cores.splice(0)) {
		await c.shutdown(0).catch(() => {});
	}
	for (const c of cleanups.splice(0)) c();
});

interface Event {
	sessionId: string;
	event: SessionEvent;
}

function collect(client: RpcClient, into: Event[]): void {
	client.setNotificationHandler((n) => {
		if (n.method === Notifications.sessionEvents) {
			into.push(n.params as unknown as Event);
		}
	});
}

async function waitEvents(events: Event[], pred: (e: SessionEvent) => boolean, count = 1, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	for (;;) {
		if (events.filter((e) => pred(e.event)).length >= count) return;
		if (Date.now() > deadline) throw new Error(`等待事件超时：${JSON.stringify(events.map((e) => e.event))}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("会话往返：new → send → assistant 条目事件 + cost/token 累计", async () => {
	const home = newHome();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());

	const events: Event[] = [];
	collect(client, events);

	const created = await client.request<{ sessionId: string }>(Methods.sessionNew, { workspace: "/w/proj" });
	const { sessionId } = created;

	const attach = await client.request<{ cursor: number; replay: string[] }>(Methods.sessionAttach, { sessionId });
	assert.equal(attach.replay.length, 1); // header

	await client.request(Methods.sessionSend, { sessionId, text: "hello" });
	await waitEvents(events, (e) => e.kind === "entry");
	const entryEvents = events.filter((e) => e.event.kind === "entry").map((e) => (e.event as { line: string }).line);
	assert.equal(entryEvents.length, 2); // user + assistant
	assert.ok(entryEvents[1].includes('"assistant"'));
	assert.ok(entryEvents[1].includes("echo(2): hello"));

	// 会话文件为 pi 兼容 JSONL（history 索引可解析）
	const file = join(paths.env(home, "web"), "sessions", `${sessionId}.jsonl`);
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	assert.equal(lines.length, 3); // header + user + assistant
	const header = JSON.parse(lines[0]) as { type: string; cwd: string | null; provider: string };
	assert.equal(header.type, "session");
	assert.equal(header.cwd, "/w/proj");
	assert.equal(header.provider, "ponda");

	// cost.snapshot 汇总
	const snap = await client.request<{
		totals: { input: number; output: number; costUsd: number };
		sessions: unknown[];
	}>(Methods.costSnapshot);
	assert.equal(snap.sessions.length, 1);
	assert.ok(snap.totals.input > 0 && snap.totals.output > 0);

	// session.list 状态：attached=1 → running
	const list = await client.request<{ sessionId: string; status: string; attached: number }[]>(Methods.sessionList);
	const item = list.find((s) => s.sessionId === sessionId);
	assert.equal(item?.status, "running");
	assert.equal(item?.attached, 1);

	await core.shutdown(0);
	client.close();
});

test("attach/detach：detach 后任务继续，重 attach 按游标重放错过条目", async () => {
	const home = newHome();
	const core = new DaemonCore({
		home,
		env: "web",
		loop: new ScriptedAgentLoop(["r1", "r2", "r3"]),
	});
	cores.push(core);
	await core.start();

	const a = new RpcClient();
	await a.connect(core.socketPath());
	const events: Event[] = [];
	collect(a, events);

	const { sessionId } = await a.request<{ sessionId: string }>(Methods.sessionNew);
	await a.request(Methods.sessionAttach, { sessionId });
	await a.request(Methods.sessionSend, { sessionId, text: "q1" });
	await waitEvents(events, (e) => e.kind === "entry", 2); // user+assistant r1
	const cursorAfterFirst = events.filter((e) => e.event.kind === "entry").length + 1; // header + 2

	// detach：UI 离开
	await a.request(Methods.sessionDetach, { sessionId });
	const list1 = await a.request<{ status: string }[]>(Methods.sessionList);
	assert.equal(list1[0]?.status, "detached");

	// 会话继续执行两条（无人 attach）
	events.length = 0;
	await a.request(Methods.sessionSend, { sessionId, text: "q2" });
	await a.request(Methods.sessionSend, { sessionId, text: "q3" });
	await waitEvents(events, () => false, 1, 100).catch(() => {}); // 不应有事件送达
	assert.equal(events.length, 0, "detach 后无事件推送");

	// 等后台队列排空（poll session.list processing=false）
	for (let i = 0; i < 100; i++) {
		const l = await a.request<{ processing: boolean; entryCount: number }[]>(Methods.sessionList);
		if (l[0]?.processing === false && (l[0]?.entryCount ?? 0) >= 7) break;
		await new Promise((r) => setTimeout(r, 20));
	}

	// 重 attach（新客户端 B）带游标 → 重放错过条目
	const b = new RpcClient();
	await b.connect(core.socketPath());
	const eventsB: Event[] = [];
	collect(b, eventsB);
	const att = await b.request<{ replay: string[]; cursor: number }>(Methods.sessionAttach, {
		sessionId,
		cursor: cursorAfterFirst,
	});
	assert.equal(att.replay.length, 4); // q2 user + r2 + q3 user + r3
	assert.ok(att.replay[0].includes('"user"'));
	assert.ok(att.replay[1].includes("r2"));

	await core.shutdown(0);
	a.close();
	b.close();
});

test("权限往返：requestPermission 广播 + permission.respond 应答", async () => {
	const home = newHome();
	const core = new DaemonCore({ home, env: "web", permissionTimeoutMs: 2000 });
	cores.push(core);
	await core.start();
	const client = new RpcClient();
	await client.connect(core.socketPath());

	let gotRequest: { requestId: string; privilege: string } | null = null;
	client.setNotificationHandler((n) => {
		if (n.method === Notifications.permissionRequest) {
			const req = (n.params as { request: { requestId: string; privilege: string } }).request;
			gotRequest = { requestId: req.requestId, privilege: req.privilege };
		}
	});

	const answerP = core.requestPermission(
		{ privilege: "write", reason: "写工作区外文件", detail: { tool: "write", mode: "C" } },
		2000,
	);
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(gotRequest !== null);
	const g = gotRequest as { requestId: string };
	const resp = await client.request(Methods.permissionRespond, {
		requestId: g.requestId,
		approved: true,
		scope: "session",
	});
	assert.deepEqual(resp, { answered: g.requestId });
	assert.deepEqual(await answerP, { approved: true, scope: "session" });

	// 超时路径：不应答 → 拒绝
	const timeoutP = core.requestPermission(
		{ privilege: "execute", reason: "x", detail: { tool: "bash", mode: "danger" } },
		80,
	);
	assert.deepEqual(await timeoutP, { approved: false, scope: "once" });

	await core.shutdown(0);
	client.close();
});

test("daemon.shutdown：RPC 触发优雅退出并触发 onExit", async () => {
	const home = newHome();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();
	let exited = -1;
	core.onExit = (code) => {
		exited = code;
	};
	const client = new RpcClient();
	await client.connect(core.socketPath());
	await client.request(Methods.daemonShutdown);
	for (let i = 0; i < 50 && exited === -1; i++) await new Promise((r) => setTimeout(r, 20));
	assert.equal(exited, 0);
	client.close();
});
