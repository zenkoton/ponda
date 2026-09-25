import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HistoryIndex, parseSessionFile } from "../src/history.ts";
import { paths } from "../src/paths.ts";
import { ResourceStore } from "../src/resources.ts";
import { EnvStore } from "../src/store.ts";

const homes: string[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-res-"));
	homes.push(h);
	return h;
}
afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

function setup() {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.activate("default");
	return { home, store, res: new ResourceStore(home, store) };
}

test("池：本地安装、多版本、latest 解析、list", () => {
	const { home, res } = setup();
	const src = join(home, "src-skill");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "---\nname: t\ndescription: test skill\n---\nbody");

	res.installFromPath("skill", "t", src, { version: "0.1.0" });
	res.installFromPath("skill", "t", src, { version: "0.2.0" });
	assert.deepEqual(res.versions("skill", "t"), ["0.1.0", "0.2.0"]);
	assert.equal(res.latestVersion("skill", "t"), "0.2.0");
	const metas = res.list();
	assert.ok(metas.some((m) => m.kind === "skill" && m.name === "t" && m.version === "0.2.0"));
	assert.equal(metas.find((m) => m.name === "t")?.description, "test skill");
});

test("启用 skill：manifest 更新 + 软链接注入（最新版）", () => {
	const { home, store, res } = setup();
	const src = join(home, "s");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "# s");
	res.installFromPath("skill", "s", src, { version: "1.0.0" });

	res.enable("default", "skill", "s");
	assert.deepEqual(store.readManifest("default")?.skills, ["s"]);
	const link = join(paths.env(home, "default"), "skills", "s");
	assert.ok(existsSync(link));
	assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /# s/);

	// 停用 → 链接清理、manifest 移除
	res.disable("default", "skill", "s");
	assert.deepEqual(store.readManifest("default")?.skills, []);
	assert.ok(!existsSync(link));
});

test("钉扎版本：enable --version 指向精确版本目录", () => {
	const { home, res } = setup();
	const src = join(home, "s");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "# s");
	res.installFromPath("skill", "s", src, { version: "1.0.0" });
	res.installFromPath("skill", "s", src, { version: "2.0.0" });

	res.enable("default", "skill", "s", { version: "1.0.0" });
	const link = join(paths.env(home, "default"), "skills", "s");
	assert.match(readlinkOf(link), /s@1\.0\.0$/);
});

test("工具：installCommandTool + enable 写入 tools.custom；继承停用产生删除条目", () => {
	const { home, store, res } = setup();
	const src = join(home, "s");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "# s");
	res.installFromPath("skill", "s", src, { version: "1.0.0" });
	res.installCommandTool({ name: "deploy", description: "d", command: "dep" });

	res.enable("default", "tool", "deploy");
	assert.equal(store.resolve("default").effective.tools.custom[0]?.name, "deploy");

	// 子环境停用继承的工具 → ToolDeletion
	store.create({ name: "child", base: "default" });
	res.disable("child", "tool", "deploy");
	const customs = store.readManifest("child")?.tools?.custom;
	assert.deepEqual(customs, [{ name: "deploy", delete: true }]);
	// 但父环境仍在
	assert.equal(store.resolve("default").effective.tools.custom.length, 1);
	assert.equal(store.resolve("child").effective.tools.custom.length, 0);
});

test("provider：入池 + 启用渲染 models.json；停用产生 null 删除", () => {
	const { home, store, res } = setup();
	res.installProviderDef("glh", {
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		apiKey: "$KEY",
		models: [{ id: "m1" }, { id: "m2" }],
	});
	res.enable("default", "provider", "glh");
	const modelsFile = join(paths.env(home, "default"), "models.json");
	assert.ok(existsSync(modelsFile));
	const parsed = JSON.parse(readFileSync(modelsFile, "utf8")) as {
		providers: Record<string, { models: { id: string }[] }>;
	};
	assert.deepEqual(
		parsed.providers.glh.models.map((m) => m.id),
		["m1", "m2"],
	);

	store.create({ name: "child", base: "default" });
	res.disable("child", "provider", "glh");
	assert.equal(store.readManifest("child")?.models?.providers?.glh, null);
	assert.equal(store.resolve("child").effective.models.providers?.glh, undefined);
});

test("envReferences + remove", () => {
	const { home, res } = setup();
	const src = join(home, "s");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "# s");
	res.installFromPath("skill", "s", src, { version: "1.0.0" });
	res.enable("default", "skill", "s");
	assert.deepEqual(res.envReferences("skill", "s"), ["default"]);
	res.disable("default", "skill", "s");
	res.remove("skill", "s");
	assert.equal(res.latestVersion("skill", "s"), null);
});

function readlinkOf(p: string): string {
	return readlinkSync(p);
}

// —— history ——

test("parseSessionFile：header/标题/usage 解析", () => {
	const home = newHome();
	const f = join(home, "s.jsonl");
	writeFileSync(
		f,
		[
			JSON.stringify({
				type: "session",
				id: "xyz",
				timestamp: "2026-09-25T10:00:00.000Z",
				cwd: "/w/proj",
				provider: "p",
				modelId: "m",
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2026-09-25T10:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello world foo" }] },
			}),
			JSON.stringify({
				type: "message",
				timestamp: "2026-09-25T10:01:00.000Z",
				message: { role: "assistant", content: [], usage: { input: 10, output: 5, cost: { total: 0.002 } } },
			}),
			"{broken json line",
		].join("\n"),
	);
	const e = parseSessionFile(f);
	assert.equal(e?.sessionId, "xyz");
	assert.equal(e?.workspace, "/w/proj");
	assert.equal(e?.title, "hello world foo");
	assert.deepEqual(e?.tokens, { input: 10, output: 5 });
	assert.equal(e?.cost, 0.002);
	assert.equal(e?.entryCount, 3); // 坏行跳过
});

test("HistoryIndex：list/keyword/remove", () => {
	const { home, store } = setup();
	const dir = join(paths.env(home, "default"), "sessions");
	writeFileSync(
		join(dir, "a1.jsonl"),
		[
			JSON.stringify({ type: "session", id: "a1", cwd: "/w/a" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "auth refactor" } }),
		].join("\n"),
	);
	writeFileSync(
		join(dir, "b2.jsonl"),
		[
			JSON.stringify({ type: "session", id: "b2", cwd: "/w/b" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "无关内容" } }),
		].join("\n"),
	);

	const idx = new HistoryIndex(store);
	assert.equal(idx.list().length, 2);
	assert.equal(idx.list({ keyword: "auth" }).length, 1);
	assert.equal(idx.list({ keyword: "无关" })[0].sessionId, "b2");
	const hit = idx.remove("a1");
	assert.equal(hit.sessionId, "a1");
	assert.equal(idx.list().length, 1);
});
