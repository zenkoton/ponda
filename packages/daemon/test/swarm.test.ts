import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, Notifications, type SwarmCellInfo, type SwarmStatus } from "../../rpc/src/index.ts";
import { type AgentLoop, EchoAgentLoop } from "../src/agent-loop.ts";
import { DaemonCore } from "../src/core.ts";
import { SessionManager } from "../src/sessions.ts";
import { MAIN_CELL_ID, SwarmRuntime } from "../src/swarm.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-swarm-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
function gitInit(ws: string): void {
	writeFileSync(join(ws, "base"), "x");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: ws });
}
function sh(cwd: string, args: string): string {
	return execFileSync("git", args.split(" "), { cwd, encoding: "utf8" }).trim();
}
afterEach(async () => {
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

async function waitCell(
	rt: SwarmRuntime,
	cellId: string,
	pred: (c: SwarmCellInfo) => boolean,
	ms = 3000,
): Promise<SwarmCellInfo> {
	for (let i = 0; i < ms / 20; i++) {
		const c = rt.status().cells.find((x) => x.cellId === cellId);
		if (c !== undefined && pred(c)) return c;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error(`cell 状态等待超时：${JSON.stringify(rt.status().cells.find((x) => x.cellId === cellId))}`);
}

test("spawn → 独立会话执行 brief → done + 结果摘要 + worktree 创建与清理", async () => {
	const home = newDir();
	const ws = newDir();
	gitInit(ws);
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	const rt = new SwarmRuntime({ sessions, loopFor: () => new EchoAgentLoop() });

	const cell = rt.spawn({ role: "探索者", brief: "扫描模块", workspace: ws, workspaceMode: "own-worktree" });
	assert.equal(cell.status, "running");
	assert.ok(cell.worktreeDir !== null, "own-worktree 目录已创建");
	assert.ok(existsSync(cell.worktreeDir as string));
	// worktree 分支命名（03 §5.3 / 05 §6.1）
	assert.ok(sh(ws, "branch --list").includes(`ponda/wt/swarm-${cell.cellId}`));
	// 会话工作区 = worktree（写隔离）
	const srow = sessions.list().find((s) => s.sessionId === cell.sessionId);
	assert.equal(srow?.workspace, cell.worktreeDir);

	const done = await waitCell(rt, cell.cellId, (c) => c.status === "done");
	assert.ok((done.lastResult ?? "").includes("echo(2): 扫描模块"), `结果摘要：${done.lastResult}`);
	// done 后 worktree 清理
	for (let i = 0; i < 50 && existsSync(cell.worktreeDir as string); i++) {
		await new Promise((r) => setTimeout(r, 20));
	}
	assert.ok(!existsSync(cell.worktreeDir as string), "worktree 已清理");
});

test("非 git 工作区降级 shared-worktree 仍可运行", async () => {
	const home = newDir();
	const ws = newDir(); // 无 git
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	const rt = new SwarmRuntime({ sessions, loopFor: () => new EchoAgentLoop() });
	const cell = rt.spawn({ role: "分析", brief: "只读分析", workspace: ws });
	assert.equal(cell.worktreeDir, null);
	assert.equal(cell.workspace, ws);
	await waitCell(rt, cell.cellId, (c) => c.status === "done");
});

test("信箱：定向发送/收件即消费；发往运行中 cell 时顺带投递为其会话输入", async () => {
	const home = newDir();
	const ws = newDir();
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());

	// 受控门闩 loop：process 挂起直至放行（保证发送时 cell 仍在运行）
	let release: () => void = () => {};
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const gatedLoop: AgentLoop = {
		name: "gated",
		async process(input) {
			await gate;
			return { assistantText: `handled:${input.userText}`, usage: { input: 1, output: 1, costUsd: 0.0001 } };
		},
	};
	const rt = new SwarmRuntime({ sessions, loopFor: () => gatedLoop });

	// 主 agent 信箱
	const m0 = rt.send(MAIN_CELL_ID, MAIN_CELL_ID, "自言自语");
	assert.equal(rt.read(MAIN_CELL_ID)[0]?.id, m0.id);
	assert.equal(rt.read(MAIN_CELL_ID).filter((m) => !m.consumed).length, 0, "read 后已消费");

	const cell = rt.spawn({ role: "实现者", brief: "b1", workspace: ws });
	await new Promise((r) => setTimeout(r, 50)); // 确保 brief 处理中（挂起）
	rt.send(MAIN_CELL_ID, cell.cellId, "进度如何");
	const unread = rt.status().cells.find((c) => c.cellId === cell.cellId)?.unread ?? 0;
	assert.equal(unread, 1, "未读计数");
	const box = rt.read(cell.cellId);
	assert.equal(box.at(-1)?.payload, "进度如何");

	release();
	const done = await waitCell(rt, cell.cellId, (c) => c.status === "done", 5000);
	assert.ok((done.lastResult ?? "").includes("进度如何"), `顺带投递后的回复：${done.lastResult}`);
});

test("并发熔断：maxParallel=1 时第二个 spawn 拒绝", async () => {
	const home = newDir();
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	const rt = new SwarmRuntime({ sessions, loopFor: () => new EchoAgentLoop(), maxParallel: 1 });
	const c1 = rt.spawn({ role: "a", brief: "slow" });
	assert.throws(() => rt.spawn({ role: "b", brief: "x" }), /并发熔断/);
	await waitCell(rt, c1.cellId, (c) => c.status === "done");
	const c2 = rt.spawn({ role: "b", brief: "x" }); // 空闲后放行
	await waitCell(rt, c2.cellId, (c) => c.status === "done");
});

test("费用熔断：累计费用达阈值后拒绝新 spawn", async () => {
	const home = newDir();
	const ws = newDir();
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	// 费用极小阈值（echo 成本 ~0.0004/次）
	const rt = new SwarmRuntime({ sessions, loopFor: () => new EchoAgentLoop(), maxSwarmCostUsd: 0.0005 });
	const c1 = rt.spawn({ role: "a", brief: "xxxxx", workspace: ws });
	await waitCell(rt, c1.cellId, (c) => c.status === "done");
	assert.throws(() => rt.spawn({ role: "b", brief: "x" }), /费用熔断/);
});

test("失败重试一次：首轮无输出 → retrying 新会话 → 仍失败则 failed", async () => {
	const home = newDir();
	const ws = newDir();
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	// loopFor：首轮抛错（无 assistant 输出），重试轮正常
	const rt = new SwarmRuntime({
		sessions,
		loopFor: (cell) =>
			cell.retries === 0
				? ({
						name: "boom",
						async process() {
							throw new Error("boom");
						},
					} satisfies AgentLoop)
				: new EchoAgentLoop(),
	});
	const cell = rt.spawn({ role: "r", brief: "x", workspace: ws });
	const done = await waitCell(rt, cell.cellId, (c) => c.status === "done", 5000);
	assert.equal(done.retries, 1, "重试一次后成功");
});

test("cancel：运行中取消 → cancelled", async () => {
	const home = newDir();
	const sessions = new SessionManager(home, "web", new EchoAgentLoop());
	const rt = new SwarmRuntime({
		sessions,
		loopFor: () => ({
			name: "slow",
			process: () => new Promise<never>(() => {}),
		}),
	});
	const cell = rt.spawn({ role: "卡住", brief: "x" });
	const c = rt.cancel(cell.cellId);
	assert.equal(c.status, "cancelled");
});

// —— RPC 端到端 + 事件 ——

test("RPC：swarm.spawn/status/send/read/cancel + swarmEvents", async () => {
	const home = newDir();
	const ws = newDir();
	gitInit(ws);
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();

	const c = new RpcClient();
	await c.connect(core.socketPath());
	const events: { kind: string }[] = [];
	c.setNotificationHandler((n) => {
		if (n.method === Notifications.swarmEvents) {
			events.push((n.params as { event: { kind: string } }).event);
		}
	});

	const cell = await c.request<SwarmCellInfo>(Methods.swarmSpawn, {
		role: "审校者",
		brief: "review 代码",
		workspace: ws,
	});
	assert.equal(cell.status, "running");

	await c.request(Methods.swarmSend, { from: "main", to: cell.cellId, payload: "快点" });
	const box = await c.request<{ payload: string; consumed: boolean }[]>(Methods.swarmRead, {
		cellId: cell.cellId,
	});
	assert.ok(box.some((m) => m.payload === "快点"));

	for (let i = 0; i < 150; i++) {
		const st = await c.request<SwarmStatus>(Methods.swarmStatus);
		if (st.cells[0]?.status === "done") break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const st = await c.request<SwarmStatus>(Methods.swarmStatus);
	assert.equal(st.cells[0]?.status, "done");
	assert.ok(st.totals.done === 1);
	assert.ok((st.cells[0]?.lastResult ?? "").includes("review 代码"));

	const cell2 = await c.request<SwarmCellInfo>(Methods.swarmSpawn, {
		role: "慢",
		brief: "slow",
		workspace: ws,
	});
	const cancelled = await c.request<SwarmCellInfo>(Methods.swarmCancel, { cellId: cell2.cellId });
	assert.equal(cancelled.status, "cancelled");

	await new Promise((r) => setTimeout(r, 100));
	assert.ok(events.some((e) => e.kind === "spawned"));
	assert.ok(events.some((e) => e.kind === "done"));
	c.close();
});
