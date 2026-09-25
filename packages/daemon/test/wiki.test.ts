import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type PiToolRegistration, registerWikiTools } from "../../../extensions/wiki/index.ts";
import type { WikiSearchHit } from "../../core/src/wiki.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { DaemonCore } from "../src/core.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
function newWs(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-wiki2-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	mkdirSync(join(d, "src"), { recursive: true });
	writeFileSync(join(d, "src", "auth.ts"), "// auth module: login session token\n");
	execFileSync("git", ["init", "-q"], { cwd: d });
	execFileSync("git", ["add", "-A"], { cwd: d });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c1"], { cwd: d });
	return d;
}
afterEach(async () => {
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("RPC + 工具注册端到端：wiki.build → wiki_search/read/update（经 extensions/wiki 工具表）", async () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-wikirpc-"));
	cleanups.push(() => rmSync(home, { recursive: true, force: true }));
	const ws = newWs();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();

	const client = new RpcClient();
	await client.connect(core.socketPath());

	// 构建（moduleBody 经 RPC 注入——真实链路为 agent 供给）
	const built = await client.request<{ created: string[] }>(Methods.wikiBuild, {
		workspace: ws,
		moduleBody: "auth 模块管理 login 与 session token",
	});
	assert.ok(built.created.includes("modules/src.md"));

	// 工具注册（extensions/wiki）：三件套名称与参数 schema
	const registered: PiToolRegistration[] = [];
	const fakePi = {
		registerTool: (t: PiToolRegistration) => registered.push(t),
	};
	const tools = registerWikiTools(fakePi, { workspace: ws, client });
	assert.deepEqual(
		tools.map((t) => t.name),
		["wiki_search", "wiki_read", "wiki_update"],
	);
	assert.equal(registered.length, 3, "经 pi.registerTool 注册");

	// wiki_search 工具 → RPC → 倒排索引
	const searchOut = (await tools[0]?.execute({ query: "token" })) as string[];
	assert.ok(
		searchOut.some((l) => l.includes("modules/src.md")),
		`检索结果：${JSON.stringify(searchOut)}`,
	);

	// wiki_read 工具
	const body = (await tools[1]?.execute({ page: "modules/src.md" })) as string;
	assert.ok(body.includes("session token"));

	// wiki_update 工具（普通页整页重写）
	const rel = (await tools[2]?.execute({ page: "glossary.md", content: "# 术语表\n\n- token: 令牌\n" })) as string;
	assert.equal(rel, "glossary.md");
	const hits2 = await client.request<WikiSearchHit[]>(Methods.wikiSearch, { workspace: ws, query: "令牌" });
	assert.ok(hits2.some((h) => h.rel === "glossary.md"));

	// 直接 RPC 检索/读取（daemon 侧同一实现）
	const page = await client.request<{ frontmatter: { confidence: number } }>(Methods.wikiRead, {
		workspace: ws,
		page: "modules/src.md",
	});
	assert.equal(page.frontmatter.confidence, 0.9);

	client.close();
});
