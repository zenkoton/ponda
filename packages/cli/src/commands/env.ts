/** `ponda env` 子命令族（design: 01-environment.md §4） */
import { readFileSync } from "node:fs";
import { EnvNotFoundError, ValidationError } from "../../../core/src/index.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { resolveEnvForWorkspace } from "../../../core/src/workspace.ts";
import { c, table, truncate } from "../ui.ts";

export interface CliContext {
	store: EnvStore;
	json: boolean;
}

function printJson(v: unknown): void {
	console.log(JSON.stringify(v, null, 2));
}

function requireEnv(store: EnvStore, name: string): void {
	if (!store.exists(name)) throw new EnvNotFoundError(name);
}

export async function runEnv(
	ctx: CliContext,
	sub: string,
	args: string[],
	flags: Map<string, string | boolean>,
): Promise<number> {
	const { store } = ctx;
	const positional = args;

	switch (sub) {
		case "create": {
			const name = positional[0];
			if (!name)
				return usageError(
					"ponda env create <name> [--base <env>] [--description <text>] [--system-prompt <text|@file>]",
				);
			let systemPrompt: string | undefined;
			const sp = flags.get("system-prompt");
			if (typeof sp === "string") {
				systemPrompt = sp.startsWith("@") ? readFileOrThrow(sp.slice(1)) : sp;
			}
			const res = store.create({
				name,
				base: typeof flags.get("base") === "string" ? (flags.get("base") as string) : undefined,
				description:
					typeof flags.get("description") === "string" ? (flags.get("description") as string) : undefined,
				systemPrompt,
			});
			if (ctx.json) {
				printJson({ created: name, chain: res.chain });
				return 0;
			}
			console.log(c.green(`✓`), `环境已创建：${c.bold(name)}（继承链：${res.chain.join(" ← ")}）`);
			console.log(c.dim(`  激活：ponda env activate ${name}`));
			return 0;
		}

		case "rm":
		case "remove": {
			const name = positional[0];
			if (!name) return usageError("ponda env rm <name> [--force]");
			requireEnv(store, name);
			store.remove(name, { force: flags.get("force") === true });
			console.log(
				c.green("✓"),
				`环境已删除：${name}${flags.get("force") === true ? "（--force，未进回收站）" : "（已移入 ~/.ponda/.trash，7 天内可恢复）"}`,
			);
			return 0;
		}

		case "activate": {
			const name = positional[0];
			if (!name) return usageError("ponda env activate <name> [--dry-run]");
			requireEnv(store, name);
			if (flags.get("dry-run") === true) {
				const res = store.resolve(name);
				console.log(`将激活 ${c.bold(name)}（继承链：${res.chain.join(" ← ")}）`);
				console.log(c.dim(`渲染产物将写入：${store.home}/envs/${name}`));
				return 0;
			}
			const res = store.activate(name);
			if (ctx.json) {
				printJson({ activeEnv: name, chain: res.chain });
				return 0;
			}
			console.log(c.green("✓"), `已激活 ${c.bold(name)}  提示符：${c.cyan(`(pi:${name})`)}`);
			console.log(c.dim("  shell 集成将在下个提示符刷新；兼容导出 PI_CODING_AGENT_DIR 供子进程使用"));
			return 0;
		}

		case "deactivate": {
			store.deactivate();
			console.log(c.green("✓"), "已清除全局激活（工作区绑定不受影响）");
			return 0;
		}

		case "list":
		case "ls": {
			const list = store.list();
			if (ctx.json) {
				printJson(list);
				return 0;
			}
			if (list.length === 0) {
				console.log(c.dim("尚无环境。运行 ponda init 或 ponda env create <name>"));
				return 0;
			}
			console.log(
				table(
					["", "NAME", "BASE", "SKILLS", "EXTS", "THEMES", "SESSIONS", "UPDATED", "DESCRIPTION"],
					list.map((e) => [
						e.active ? c.green("*") : "",
						e.active ? c.bold(e.name) : e.name,
						e.base ?? "-",
						e.skillCount,
						e.extensionCount,
						e.themeCount,
						e.sessionCount,
						e.updatedAt.slice(0, 10),
						truncate(e.description ?? "", 32),
					]),
				),
			);
			return 0;
		}

		case "info": {
			const name = positional[0];
			if (!name) return usageError("ponda env info <name>");
			requireEnv(store, name);
			const res = store.resolve(name);
			const e = res.effective;
			if (ctx.json) {
				printJson({ chain: res.chain, effective: e });
				return 0;
			}
			console.log(c.bold(`${name}`), c.dim(`继承链：${res.chain.join(" ← ")}`));
			console.log(
				`system prompt : ${truncate(typeof e.identity.systemPrompt === "string" ? e.identity.systemPrompt : `{pool:${e.identity.systemPrompt.pool}}`, 72)}`,
			);
			console.log(
				`tools         : builtin=[${e.tools.builtin.join(",")}] custom=[${e.tools.custom.map((t) => t.name).join(",") || "-"}]`,
			);
			console.log(`skills        : ${e.skills.map(String).join(", ") || c.dim("(none)")}`);
			console.log(`extensions    : ${e.extensions.map(String).join(", ") || c.dim("(none)")}`);
			console.log(
				`themes        : ${e.themes.map(String).join(", ") || c.dim("(none)")}${e.activeTheme ? `（active: ${e.activeTheme}）` : ""}`,
			);
			console.log(`mcp servers   : ${Object.keys(e.mcp).join(", ") || c.dim("(none)")}`);
			console.log(`models        : ${e.models.policy}`);
			console.log(
				`privileges    : ${e.privileges.privileges.join("|")} · sandbox=${e.privileges.sandbox.mode}/${e.privileges.sandbox.outsideWorkspace}`,
			);
			console.log(
				`runtime       : ${e.runtime.contextStrategy} · ${e.runtime.permissionMode} · subagents≤${e.runtime.maxParallelSubagents}${e.runtime.backgroundLiveness ? " · background" : ""}`,
			);
			return 0;
		}

		case "diff": {
			const [a, b] = positional;
			if (!a || !b) return usageError("ponda env diff <a> <b>");
			requireEnv(store, a);
			requireEnv(store, b);
			const d = store.diff(a, b);
			if (d.length === 0) {
				console.log(c.dim("两个环境生效配置完全一致"));
				return 0;
			}
			for (const x of d) {
				console.log(`${c.yellow(x.path)}  ${c.dim(JSON.stringify(x.a ?? null))} → ${JSON.stringify(x.b ?? null)}`);
			}
			return 0;
		}

		case "export": {
			const name = positional[0];
			const out = flags.get("out") ?? flags.get("o");
			if (!name || typeof out !== "string") return usageError("ponda env export <name> --out <dir>");
			requireEnv(store, name);
			store.exportEnv(name, out);
			console.log(c.green("✓"), `已导出 ${name} → ${out}`);
			return 0;
		}

		case "import": {
			const dir = positional[0];
			if (!dir) return usageError("ponda env import <dir> [--name <name>]");
			const res = store.importEnv(dir, {
				name: typeof flags.get("name") === "string" ? (flags.get("name") as string) : undefined,
			});
			console.log(c.green("✓"), `已导入环境 ${res.effective.name}`);
			return 0;
		}

		case "freeze": {
			const name = positional[0];
			if (!name) return usageError("ponda env freeze <name>");
			requireEnv(store, name);
			const res = store.resolve(name);
			// 快照 effective 配置为独立 manifest（切断继承，design: 01 §3.2）
			const frozen = JSON.parse(JSON.stringify(res.effective)) as typeof res.effective;
			frozen.name = name;
			delete (frozen as { base?: string }).base;
			frozen.updatedAt = new Date().toISOString();
			const file = require("node:fs") as { writeFileSync(p: string, d: string, e: string): void };
			// biome-ignore lint: 冻结操作直接覆写 manifest
			store.saveManifest(frozen);
			store.rerender(name);
			console.log(c.green("✓"), `环境 ${name} 已冻结（继承链切断，effective 配置固化为独立 manifest）`);
			return 0;
		}

		case "rename": {
			const [oldName, newName] = positional;
			if (!oldName || !newName) return usageError("ponda env rename <old> <new>");
			requireEnv(store, oldName);
			store.rename(oldName, newName);
			console.log(c.green("✓"), `${oldName} → ${newName}`);
			return 0;
		}

		case "doctor": {
			const report = store.doctor();
			if (ctx.json) {
				printJson(report);
				return report.some((r) => r.level === "error") ? 1 : 0;
			}
			if (report.length === 0) {
				console.log(c.green("✓"), "一切正常");
				return 0;
			}
			for (const r of report) {
				const tag =
					r.level === "error" ? c.red("[error]") : r.level === "warn" ? c.yellow("[warn] ") : c.dim("[info] ");
				console.log(`${tag} ${r.message}`);
			}
			return report.some((r) => r.level === "error") ? 1 : 0;
		}

		default:
			console.log(`未知子命令：${sub ?? "(空)"}
用法：
  ponda env create <name> [--base <env>] [--description <t>] [--system-prompt <t|@file>]
  ponda env rm <name> [--force]
  ponda env activate <name> [--dry-run]   |  ponda env deactivate
  ponda env list [--json]                 |  ponda env info <name> [--json]
  ponda env diff <a> <b>                  |  ponda env rename <old> <new>
  ponda env export <name> --out <dir>     |  ponda env import <dir> [--name <n>]
  ponda env doctor`);
			return 1;
	}
}

/** 当前环境解析（含工作区绑定），供各命令复用 */
export function currentEnv(store: EnvStore): { env: string; source: string } {
	const r = resolveEnvForWorkspace(process.cwd(), store.readState());
	return { env: r.env, source: r.source };
}

function usageError(msg: string): number {
	console.error(`${c.red("用法错误")}：${msg}`);
	return 1;
}

function readFileOrThrow(p: string): string {
	try {
		return readFileSync(p, "utf8");
	} catch (e) {
		throw new ValidationError(`无法读取文件 ${p}：${(e as Error).message}`);
	}
}
