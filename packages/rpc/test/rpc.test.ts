import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { RpcClient, RpcServer } from "../src/index.ts";

const dirs: string[] = [];
function sock(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-rpc-"));
	dirs.push(d);
	return join(d, "t.sock");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

async function startPair(
	handler: (method: string, params: Record<string, unknown>) => unknown,
): Promise<{ server: RpcServer; client: RpcClient; path: string }> {
	const path = sock();
	const server = new RpcServer((req) => handler(req.method, req.params ?? {}));
	await server.listen(path);
	const client = new RpcClient();
	await client.connect(path);
	return { server, client, path };
}

test("往返：请求-响应配对与参数透传", async () => {
	const { server, client } = await startPair((m, p) => ({ echo: m, n: p.n }));
	const r = await client.request<{ echo: string; n: number }>("demo.echo", { n: 42 });
	assert.deepEqual(r, { echo: "demo.echo", n: 42 });
	await server.close();
	client.close();
});

test("通知：服务端 broadcast 到达客户端 handler", async () => {
	const path = sock();
	const server = new RpcServer((req) => {
		if (req.method === "fire") server.broadcast("session.events", { kind: "status", status: "live" });
		return "ok";
	});
	await server.listen(path);
	const client = new RpcClient();
	await client.connect(path);
	const got: unknown[] = [];
	client.setNotificationHandler((n) => got.push(n.params));
	await client.request("fire");
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(got, [{ kind: "status", status: "live" }]);
	await server.close();
	client.close();
});

test("错误传播：dispatch 抛错 → 客户端 reject", async () => {
	const { server, client } = await startPair(() => {
		throw new Error("boom");
	});
	await assert.rejects(client.request("bad"), /boom/);
	await server.close();
	client.close();
});

test("并发：多请求 id 交错正确配对", async () => {
	const { server, client } = await startPair((_m, p) => {
		const delay = Number(p.delay ?? 0);
		return new Promise((resolve) => setTimeout(() => resolve(p.v), delay));
	});
	const rs = await Promise.all([
		client.request("a", { v: 1, delay: 30 }),
		client.request("b", { v: 2, delay: 5 }),
		client.request("c", { v: 3, delay: 15 }),
	]);
	assert.deepEqual(rs, [1, 2, 3]);
	await server.close();
	client.close();
});

test("超时：无响应方法按 timeout 拒绝", async () => {
	const path = sock();
	const server = new RpcServer(() => new Promise(() => {})); // 永不返回
	await server.listen(path);
	const client = new RpcClient();
	await client.connect(path);
	await assert.rejects(client.request("hang", undefined, 80), /rpc timeout: hang/);
	await server.close();
	client.close();
});

test("广播筛选：filter 只命中目标连接", async () => {
	const path = sock();
	const server = new RpcServer(() => "ok");
	await server.listen(path);
	const c1 = new RpcClient();
	const c2 = new RpcClient();
	await c1.connect(path);
	await c2.connect(path);
	const got1: unknown[] = [];
	const got2: unknown[] = [];
	c1.setNotificationHandler((n) => got1.push(n.params));
	c2.setNotificationHandler((n) => got2.push(n.params));
	server.broadcast("notice", { hello: 1 }, (conn) => conn.id === 2);
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(got1, []);
	assert.deepEqual(got2, [{ hello: 1 }]);
	await server.close();
	c1.close();
	c2.close();
});

test("断线：pending 请求被拒绝", async () => {
	const path = sock();
	const server = new RpcServer(() => new Promise(() => {}));
	await server.listen(path);
	const client = new RpcClient();
	await client.connect(path);
	const p = client.request("hang", undefined, 5000);
	client.close();
	await assert.rejects(p, /closed/);
	await server.close();
});
