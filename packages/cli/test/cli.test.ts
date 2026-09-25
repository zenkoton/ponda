import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/bin.ts";
import { shellIntegration } from "../src/commands/hook.ts";

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

test("parseArgs：--key value / --flag / --key=v / -- 透传", () => {
	const a = parseArgs(["env", "create", "x", "--base", "default", "--force", "--out=/tmp/o", "--", "--weird", "pos"]);
	assert.equal(a.flags.get("base"), "default");
	assert.equal(a.flags.get("force"), true);
	assert.equal(a.flags.get("out"), "/tmp/o");
	assert.deepEqual(a.positional, ["env", "create", "x", "--weird", "pos"]);
});

test("shellIntegration：三种 shell 均含 ponda _hook 调用", () => {
	for (const sh of ["bash", "zsh", "fish"] as const) {
		const s = shellIntegration(sh);
		assert.ok(s.includes("ponda _hook env"), sh);
		assert.ok(s.includes("ponda _hook chpwd"), sh);
	}
	assert.ok(shellIntegration("zsh").includes("precmd_functions"));
	assert.ok(shellIntegration("bash").includes("PROMPT_COMMAND"));
});

test("CLI 端到端：init → create → activate → list → _hook（退出码 0）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);

	let r = run(["init", "--print"], home);
	assert.equal(r.code, 0);

	r = run(["env", "create", "web", "--base", "default"], home);
	assert.equal(r.code, 0);

	r = run(["env", "activate", "web"], home);
	assert.equal(r.code, 0);

	r = run(["_hook", "prompt"], home);
	assert.ok(r.out.includes("(pi:web)"));

	r = run(["_hook", "env"], home);
	assert.ok(r.out.includes(`PI_CODING_AGENT_DIR=${join(home, "envs", "web")}`));

	r = run(["env", "list", "--json"], home);
	const list = JSON.parse(r.out) as { name: string; active: boolean }[];
	assert.equal(list.find((e) => e.name === "web")?.active, true);

	// 渲染产物存在
	assert.ok(existsSync(join(home, "envs", "web", "SYSTEM.md")));
	assert.ok(existsSync(join(home, "envs", "web", "settings.json")));
	assert.equal(readFileSync(join(home, "envs", "web", "SYSTEM.md"), "utf8"), "You are a helpful coding agent.");

	// doctor 干净
	r = run(["doctor"], home);
	assert.equal(r.code, 0);
});

test("CLI 退出码：不存在环境=2，非法名=3", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);
	assert.equal(run(["env", "activate", "ghost"], home).code, 2);
	assert.equal(run(["env", "create", "BAD"], home).code, 3);
	assert.equal(run(["env", "create", "env"], home).code, 3); // 保留字
});
