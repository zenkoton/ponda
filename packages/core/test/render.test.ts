import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../src/paths.ts";
import { planRender, renderEnv } from "../src/render.ts";
import { materialize } from "../src/resolve.ts";

const homes: string[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-test-"));
	homes.push(h);
	return h;
}
afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("渲染：基础产物 + 模板变量 + 幂等", () => {
	const home = newHome();
	const env = materialize(
		{
			// biome-ignore lint/suspicious/noTemplateCurlyInString: manifest 模板变量占位符
			identity: { systemPrompt: "You are ${env.name} agent.", appendSystemPrompt: "extra" },
			mcp: { browser: { command: "npx", args: ["b"] } },
			keybindings: { "ctrl.enter": "send" },
			models: {
				policy: "explicit",
				providers: { p: { baseUrl: "u", api: "openai-completions", apiKey: "$K", models: [{ id: "m" }] } },
			},
		},
		{ name: "web-dev", createdAt: "t", updatedAt: "t" },
	);
	const r1 = renderEnv(home, "web-dev", env);
	assert.ok(r1.files.some((f) => f.path === "SYSTEM.md"));
	const sys = readFileSync(join(paths.env(home, "web-dev"), "SYSTEM.md"), "utf8");
	assert.equal(sys, "You are web-dev agent.");
	assert.ok(existsSync(join(paths.env(home, "web-dev"), "mcp.json")));
	assert.ok(existsSync(join(paths.env(home, "web-dev"), "models.json")));
	assert.ok(existsSync(join(paths.env(home, "web-dev"), "keybindings.json")));

	// 幂等：再渲染一次内容不变
	const r2 = renderEnv(home, "web-dev", env);
	assert.deepEqual(
		r1.files.map((f) => [f.path, f.content]),
		r2.files.map((f) => [f.path, f.content]),
	);
});

test("渲染：空配置不产出可选文件，清理旧产物", () => {
	const home = newHome();
	const env = materialize({}, { name: "x", createdAt: "t", updatedAt: "t" });
	renderEnv(home, "x", env);
	assert.ok(!existsSync(join(paths.env(home, "x"), "mcp.json")));
	assert.ok(!existsSync(join(paths.env(home, "x"), "APPEND_SYSTEM.md")));
});

test("软链接注入：池内资源链接、私有目录不碰、孤儿清理", () => {
	const home = newHome();
	// 池内放 react skill
	const poolSkill = paths.resource(home, "skills", "react");
	mkdirSync(poolSkill, { recursive: true });
	writeFileSync(join(poolSkill, "SKILL.md"), "# react");

	const env = materialize({ skills: ["react"] }, { name: "x", createdAt: "t", updatedAt: "t" });
	renderEnv(home, "x", env);

	const link = join(paths.env(home, "x"), "skills", "react");
	assert.ok(existsSync(link), "应创建软链接");
	assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "# react", "链接可读");

	// 私有 skill：真实目录，渲染不得删除
	const priv = join(paths.env(home, "x"), "skills", "mine");
	mkdirSync(priv, { recursive: true });
	writeFileSync(join(priv, "SKILL.md"), "mine");

	// 孤儿受管链接：手工链接一个池内资源后，从 manifest 移除 react 再渲染
	const orphanTarget = paths.resource(home, "skills", "orphan");
	mkdirSync(orphanTarget, { recursive: true });
	symlinkSync("../../../resources/skills/orphan", join(paths.env(home, "x"), "skills", "orphan"));

	const env2 = materialize({ skills: [] }, { name: "x", createdAt: "t", updatedAt: "t" });
	renderEnv(home, "x", env2);

	assert.ok(!existsSync(link), "react 链接应被清理");
	assert.ok(!existsSync(join(paths.env(home, "x"), "skills", "orphan")), "孤儿受管链接应被清理");
	assert.ok(existsSync(priv), "私有目录不能被动");
	assert.deepEqual(readdirSync(join(paths.env(home, "x"), "skills")), ["mine"]);
});

test("planRender：池缺失记 warning", () => {
	const home = newHome();
	const env = materialize({ themes: ["dark-neon"] }, { name: "x", createdAt: "t", updatedAt: "t" });
	const plan = planRender(home, "x", env);
	assert.equal(plan.symlinks.length, 0);
	assert.ok(plan.warnings.some((w) => w.includes("themes/dark-neon")));
});

test("prompt 池引用", () => {
	const home = newHome();
	const poolPrompt = paths.resource(home, "prompts", "reviewer");
	mkdirSync(poolPrompt, { recursive: true });
	// biome-ignore lint/suspicious/noTemplateCurlyInString: manifest 模板变量占位符
	writeFileSync(join(poolPrompt, "PROMPT.md"), "You review code for ${env.name}.");

	const env = materialize(
		{ identity: { systemPrompt: { pool: "reviewer" } } },
		{ name: "proj", createdAt: "t", updatedAt: "t" },
	);
	renderEnv(home, "proj", env);
	assert.equal(readFileSync(join(paths.env(home, "proj"), "SYSTEM.md"), "utf8"), "You review code for proj.");
});
