#!/usr/bin/env node
/**
 * ponda CLI 入口（design: docs/design/01-environment.md）。
 * 退出码：0 成功 / 1 一般错误 / 2 环境或资源不存在 / 3 校验失败 / 4 被用户拒绝
 */
import { EnvNotFoundError, EnvStore, pondaHome, RESERVED_WORDS, ValidationError } from "../../core/src/index.ts";
import { runDaemon } from "./commands/daemon.ts";
import { runEnv } from "./commands/env.ts";
import { runGoal } from "./commands/goal.ts";
import { runHook } from "./commands/hook.ts";
import { runInit } from "./commands/init.ts";
import { runPi } from "./commands/pi.ts";
import { makeResContext, type ResourceGroup, runHistory, runMemory, runResourceGroup } from "./commands/resources.ts";
import { runSandbox } from "./commands/sandbox.ts";
import { runStats } from "./commands/stats.ts";
import { runTui } from "./commands/tui.ts";
import { c } from "./ui.ts";

const VERSION = "0.1.0";

const RESOURCE_GROUPS: readonly ResourceGroup[] = [
	"skills",
	"tools",
	"extensions",
	"themes",
	"prompts",
	"provider",
	"model",
];

interface ParsedArgs {
	flags: Map<string, string | boolean>;
	positional: string[];
}

/** 解析 --key value / --flag / --key=value；`--` 之后全部视为位置参数 */
export function parseArgs(argv: string[]): ParsedArgs {
	const flags = new Map<string, string | boolean>();
	const positional: string[] = [];
	let i = 0;
	for (; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (a.startsWith("--")) {
			const body = a.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				flags.set(body.slice(0, eq), body.slice(eq + 1));
			} else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && needsValue(body)) {
				flags.set(body, argv[i + 1]);
				i++;
			} else {
				flags.set(body, true);
			}
		} else {
			positional.push(a);
		}
	}
	return { flags, positional };
}

const VALUE_FLAGS = new Set([
	"base",
	"description",
	"system-prompt",
	"out",
	"o",
	"name",
	"env",
	"version",
	"command",
	"desc",
	"base-url",
	"api",
	"api-key",
	"model",
	"file",
	"workspace",
	"goal",
]);
function needsValue(flag: string): boolean {
	return VALUE_FLAGS.has(flag);
}

const HELP = `ponda ${VERSION} — 基于 pi coding agent 的环境管理（设计文档：docs/design/）

用法：
  ponda init [bash|zsh|fish] [--append|--print]   初始化 default 环境与 shell 集成
  ponda env <子命令>                              环境管理（create/rm/activate/list/info/diff/
                                                 export/import/rename/doctor/deactivate）
  ponda skills|tools|extensions|themes|prompts    资源管理（list/add/rm/update/info [--env E]）
  ponda provider add <n> --base-url --api --model provider/model 管理
  ponda memory reset|list                         环境记忆
  ponda history list|info|rm|attach|search        跨环境会话索引
  ponda <env> <资源组> <动作>                      免切换操作（如 ponda web skills list）
  ponda pi [args...]                              以当前环境透传运行 pi
  ponda _hook prompt|env|chpwd                    shell 集成后端（内部命令）
  ponda doctor                                    环境体检（= ponda env doctor）

选项：
  --json      机器可读输出（list/info/doctor）
  --version   版本
`;

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const { flags, positional } = parseArgs(argv);
	const json = flags.get("json") === true;

	if (positional[0] === "version") {
		console.log(VERSION);
		return 0;
	}
	if (flags.get("version") === true && positional.length === 0) {
		console.log(VERSION);
		return 0;
	}
	if (flags.get("help") === true && positional.length === 0) {
		console.log(HELP);
		return 0;
	}
	if (positional.length === 0) {
		console.log(HELP);
		return 0;
	}

	const store = new EnvStore(pondaHome());
	let cmd = positional[0];
	let rest = positional.slice(1);

	// pi 透传：转发原始参数（pi 的旗标语义与 ponda 解析器无关）
	if (cmd === "pi") {
		const piIdx = argv.indexOf("pi");
		return await runPi(store, piIdx >= 0 ? argv.slice(piIdx + 1) : rest);
	}

	// 免切换语法糖：ponda <env-name> <资源组> <动作> → 注入 --env（design: 02 §9）
	if (!RESERVED_WORDS.includes(cmd) && /^[a-z][a-z0-9-]*$/.test(cmd) && store.exists(cmd)) {
		if (rest.length === 0 || !RESOURCE_GROUPS.includes(rest[0] as ResourceGroup)) {
			console.error(
				`免切换操作 "ponda ${cmd} ..." 需跟资源组：${RESOURCE_GROUPS.join(" / ")}（例如 ponda ${cmd} skills list）`,
			);
			return 1;
		}
		flags.set("env", cmd);
		cmd = rest[0];
		rest = rest.slice(1);
	}

	switch (cmd) {
		case "init":
			return await runInit(store, rest, flags);
		case "env":
			return await runEnv({ store, json }, rest[0] ?? "", rest.slice(1), flags);
		case "doctor":
			return await runEnv({ store, json }, "doctor", [], flags);
		case "_hook":
		case "hook":
			return await runHook(store, rest[0] ?? "");
		case "memory":
			return runMemory(makeResContext(store, flags, json), rest[0] ?? "");
		case "history":
			return runHistory(makeResContext(store, flags, json), rest[0] ?? "", rest.slice(1), flags);
		case "sandbox":
			return await runSandbox(store.home, rest[0] ?? "", rest.slice(1), flags, json);
		case "daemon":
			return await runDaemon(store, rest[0] ?? "", flags, json);
		case "tui":
			return await runTui(store, rest, flags);
		case "goal":
			return await runGoal(store, rest[0] ?? "", rest.slice(1), flags, json);
		case "stats":
			return await runStats(store, rest[0] ?? "", rest.slice(1), flags, json);
		case "skills":
		case "tools":
		case "extensions":
		case "themes":
		case "prompts":
		case "provider":
		case "model":
			return await runResourceGroup(
				makeResContext(store, flags, json),
				cmd as ResourceGroup,
				rest[0] ?? "",
				rest.slice(1),
				flags,
			);

		default:
			console.error(`未知命令：${cmd}\n\n${HELP}`);
			return 1;
	}
}

function fail(e: unknown): void {
	if (e instanceof EnvNotFoundError) {
		console.error(`${c.red("未找到")}：${e.message}`);
		process.exit(2);
	}
	if (e instanceof ValidationError) {
		console.error(`${c.red("校验失败")}：${e.message}`);
		process.exit(3);
	}
	console.error(`${c.red("错误")}：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	process.exit(1);
}

process.on("unhandledRejection", (r) => {
	console.error(`${c.red("未处理异常")}：`, r);
	process.exit(1);
});

// 用 exitCode 而非 exit()，保证 stdout 刷出后再退出
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch(fail);
