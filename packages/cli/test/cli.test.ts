import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("shellIntegration：三种 shell 均含 ponda _hook 调用与真实 Ctrl-P 绑定", () => {
	for (const sh of ["bash", "zsh", "fish"] as const) {
		const s = shellIntegration(sh);
		assert.ok(s.includes("ponda _hook env"), sh);
		assert.ok(s.includes("ponda _hook chpwd"), sh);
	}
	assert.ok(shellIntegration("zsh").includes("precmd_functions"));
	assert.ok(shellIntegration("bash").includes("PROMPT_COMMAND"));
	// Ctrl-P 命名空间为真实绑定（01 §6.3；非注释示例）
	assert.ok(shellIntegration("zsh").includes("bindkey '^Pe' ponda-env-list"), "zsh bindkey");
	assert.ok(shellIntegration("zsh").includes("zle -N ponda-env-list"), "zsh widget 注册");
	assert.ok(shellIntegration("bash").includes("bind -x '\"\\C-pe\":__ponda_env_list'"), "bash bind -x");
	assert.ok(shellIntegration("fish").includes("bind \\cpe __ponda_env_list"), "fish bind");
});

test("CLI 端到端：init → create → activate → list → _hook（退出码 0）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);

	let r = run(["init"], home);
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

test("init --print 无副作用：不创建 default 环境（PM 审查修复）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);
	const r = run(["init", "--print"], home);
	assert.equal(r.code, 0);
	assert.ok(r.out.includes("ponda _hook"), "输出集成脚本");
	assert.ok(!existsSync(join(home, "envs", "default")), "不创建 default 环境");
});

test("子命令 --help/-h 冷启动可用：不检查环境存在性（PM 审查修复）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);
	for (const args of [
		["tui", "--help"],
		["daemon", "-h"],
		["goal", "--help"],
	]) {
		const r = run(args, home);
		assert.equal(r.code, 0, `${args.join(" ")} 退出码`);
		assert.ok(r.out.includes("ponda"), "打印帮助");
	}
});

test("env freeze：ESM 下可用（修复 require 崩溃）且切断继承", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);
	run(["init"], home);
	run(["env", "create", "web", "--base", "default"], home);
	const r = run(["env", "freeze", "web"], home);
	assert.equal(r.code, 0, `freeze 成功（输出：${r.out.slice(0, 200)}）`);
	const manifest = JSON.parse(readFileSync(join(home, "envs", "web", "manifest.json"), "utf8")) as {
		base?: string;
		name: string;
	};
	assert.equal(manifest.base, undefined, "继承链切断");
	assert.equal(manifest.name, "web");
});

test("history attach：8 位短 id 前缀解析（PM 审查修复）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cli-"));
	homes.push(home);
	run(["init"], home);
	const sessDir = join(home, "envs", "default", "sessions");
	mkdirSync(sessDir, { recursive: true });
	const id = "1a2b3c4d-1111-2222-3333-444455556666";
	writeFileSync(
		join(sessDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", id, cwd: "/w/p", timestamp: "2026-09-25T00:00:00Z" })}\n${JSON.stringify({ type: "message", timestamp: "2026-09-25T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
	);
	const r = run(["history", "list"], home);
	assert.ok(r.out.includes("1a2b3c4d"), "列表显示短 id");
	// attach 前缀解析：pi 入口缺失时给出可行动错误（而非 history not found）
	const a = run(["history", "attach", "1a2b3c4d"], home);
	assert.notEqual(a.code, 0, "无 pi 构建产物时不能静默成功");
	assert.ok(!a.out.includes("history not found"), "短 id 已被前缀解析接受");
});
