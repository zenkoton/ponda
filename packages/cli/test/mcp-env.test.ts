/**
 * `ponda mcp`（02 §4 mcp-server 类别：manifest.mcp → mcp.json，daemon 消费）
 * 与 `ponda env create` 旗标面（01 §4.1：--tool/--privilege/--skill/--no-render）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string): { code: number; out: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1" },
			encoding: "utf8",
		});
		return { code: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string };
		return { code: err.status ?? 1, out: err.stdout ?? "" };
	}
}

afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("mcp 类别：add → mcp.json 渲染 → list/免切换 → rm", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-mcpcli-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);

	// add：写入 manifest.mcp 并渲染
	const add = run(["mcp", "add", "echo-server", "--command", "node", "--args", "server.mjs,--stdio"], home);
	assert.equal(add.code, 0, add.out);
	const mcpJson = JSON.parse(readFileSync(join(home, "envs", "default", "mcp.json"), "utf8")) as {
		mcpServers: Record<string, { command: string; args: string[] }>;
	};
	assert.equal(mcpJson.mcpServers["echo-server"]?.command, "node");
	assert.deepEqual(mcpJson.mcpServers["echo-server"]?.args, ["server.mjs", "--stdio"]);

	// list（含免切换语法：先建第二个环境验证 per-env 隔离）
	assert.equal(run(["env", "create", "web", "--base", "default"], home).code, 0);
	const list = run(["mcp", "list"], home);
	assert.ok(list.out.includes("echo-server"), "default 环境列出");
	const webList = run(["web", "mcp", "list"], home);
	assert.ok(webList.out.includes("echo-server"), "子环境继承父声明（01 §3 并集）");
	// per-env 隔离：各环境渲染产物物理分离（envs/<env>/mcp.json 各自独立）
	const webJson = readFileSync(join(home, "envs", "web", "mcp.json"), "utf8");
	assert.ok(webJson.includes("echo-server"), "web 的 mcp.json 独立渲染");

	// info / rm
	const info = run(["mcp", "info", "echo-server"], home);
	assert.ok(info.out.includes("node"));
	assert.equal(run(["mcp", "rm", "echo-server"], home).code, 0);
	assert.ok(!existsSync(join(home, "envs", "default", "mcp.json")), "移除后 mcp.json 清理");
});

test("env create 旗标面：--tool/--privilege/--skill/--no-render（01 §4.1）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-envflags-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);

	// 池内装一个 skill 供 --skill 启用
	const src = join(home, "my-skill");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "---\ndescription: mine\n---\nbody");
	assert.equal(run(["skills", "add", src, "mine"], home).code, 0);

	const r = run(
		[
			"env",
			"create",
			"ci",
			"--base",
			"default",
			"--tool",
			"deploy=./d.sh $ARGUMENTS",
			"--privilege",
			"read,execute",
			"--skill",
			"mine",
			"--no-render",
		],
		home,
	);
	assert.equal(r.code, 0, r.out);

	const manifest = JSON.parse(readFileSync(join(home, "envs", "ci", "manifest.json"), "utf8")) as {
		tools?: { custom: { name: string; command: string }[] };
		privileges?: { privileges: string[] };
		skills: string[];
	};
	assert.equal(manifest.tools?.custom?.[0]?.name, "deploy");
	assert.equal(manifest.tools?.custom?.[0]?.command, "./d.sh $ARGUMENTS");
	assert.deepEqual(manifest.privileges?.privileges, ["read", "execute"]);
	assert.ok(manifest.skills.includes("mine"), "--skill 启用");
	// --no-render：无渲染产物；activate 后渲染（含软链接）
	assert.ok(!existsSync(join(home, "envs", "ci", "SYSTEM.md")), "no-render 不产出");
	assert.equal(run(["env", "activate", "ci"], home).code, 0);
	assert.ok(existsSync(join(home, "envs", "ci", "skills", "mine")), "activate 渲染软链接");
	assert.ok(existsSync(join(home, "envs", "ci", "SYSTEM.md")), "activate 渲染产物");

	// 非法旗标值退出码
	assert.equal(run(["env", "create", "bad", "--privilege", "fly"], home).code, 3);
});
