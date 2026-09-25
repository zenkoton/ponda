import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { ensureDaemon } from "../src/spawn.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN = join(__dirname, "..", "src", "main.ts");

const cleanups: (() => void)[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-dchild-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

async function rpcCall<T>(home: string, env: string, method: string, params?: Record<string, unknown>): Promise<T> {
	const c = new RpcClient();
	await c.connect(join(home, "daemon", `${env}.sock`), 3000);
	try {
		return await c.request<T>(method, params, 5000);
	} finally {
		c.close();
	}
}

test("子进程 daemon：懒启动 → 会话 → SIGKILL → 恢复标记 interrupted", async () => {
	const home = newHome();

	// 1) 懒启动（detached 子进程）
	const h = await ensureDaemon(home, "web", { idleMs: 60000 });
	assert.ok(h.pid > 0);
	h.client.close();

	// 2) 建 live 会话并产生条目
	const created = await rpcCall<{ sessionId: string }>(home, "web", Methods.sessionNew, { workspace: "/w" });
	const { sessionId } = created;
	await rpcCall(home, "web", Methods.sessionSend, { sessionId, text: "hello" });
	// 等待 assistant 条目落盘（echo loop 异步）
	for (let i = 0; i < 100; i++) {
		const l = await rpcCall<{ processing: boolean }[]>(home, "web", Methods.sessionList);
		if (l[0]?.processing === false) break;
		await new Promise((r) => setTimeout(r, 20));
	}
	const file = join(home, "envs", "web", "sessions", `${sessionId}.jsonl`);
	const before = readFileSync(file, "utf8").split("\n").filter(Boolean);
	assert.ok(before.length >= 3);

	// 3) SIGKILL 模拟崩溃
	const state = JSON.parse(readFileSync(join(home, "daemon", "web.state.json"), "utf8")) as { pid: number };
	const victim: ChildProcess = spawn(process.execPath, ["-e", `process.kill(${state.pid}, "SIGKILL")`]);
	await new Promise((r) => victim.on("exit", r));
	await new Promise((r) => setTimeout(r, 200));

	// 4) 重启（懒启动）→ 会话被标记 interrupted
	const h2 = await ensureDaemon(home, "web", { idleMs: 60000 });
	h2.client.close();
	const list = await rpcCall<{ sessionId: string; status: string }[]>(home, "web", Methods.sessionList);
	const item = list.find((s) => s.sessionId === sessionId);
	assert.equal(item?.status, "interrupted");
	const after = readFileSync(file, "utf8");
	assert.ok(after.includes("ponda.interrupted"), "会话文件含 interrupted 标记");

	// 5) interrupted 会话只读 attach（历史查看）；send 拒绝
	const ro = await rpcCall<{ readOnly: boolean }>(home, "web", Methods.sessionAttach, { sessionId });
	assert.equal(ro.readOnly, true);
	await assert.rejects(rpcCall(home, "web", Methods.sessionSend, { sessionId, text: "x" }), /interrupted/);
	await rpcCall(home, "web", Methods.sessionDetach, { sessionId });

	// 6) 清理：shutdown
	await rpcCall(home, "web", Methods.daemonShutdown);
	await new Promise((r) => setTimeout(r, 200));
});

test("空闲自退出：idle-ms 后无活动且无连接 → 进程退出", async () => {
	const home = newHome();
	const child = spawn(process.execPath, [MAIN, "--env", "web", "--home", home, "--idle-ms", "700"], {
		stdio: "ignore",
	});
	const exited = new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? -1)));

	// 等就绪
	for (let i = 0; i < 50; i++) {
		const c = new RpcClient();
		try {
			await c.connect(join(home, "daemon", "web.sock"), 300);
			c.close();
			break;
		} catch {
			c.close();
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	// 触碰一次活动后放任空闲
	await rpcCall(home, "web", Methods.daemonPing);

	const code = await Promise.race([
		exited,
		new Promise<number>((_, rej) => setTimeout(() => rej(new Error("空闲退出超时")), 5000)),
	]);
	assert.equal(code, 0);
});
