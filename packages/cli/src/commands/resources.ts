/** `ponda skills/tools/extensions/themes/prompts/provider/model` 资源命令族（design: 02-resources.md §4-§6） */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EnvStore,
	HistoryIndex,
	type ProviderDef,
	paths,
	type ResourceKind,
	ResourceStore,
} from "../../../core/src/index.ts";
import { c, table, truncate } from "../ui.ts";
import { currentEnv } from "./env.ts";

export type ResourceGroup = "skills" | "tools" | "extensions" | "themes" | "prompts" | "provider" | "model";

const GROUP_KIND: Record<ResourceGroup, ResourceKind> = {
	skills: "skill",
	tools: "tool",
	extensions: "extension",
	themes: "theme",
	prompts: "prompt",
	provider: "provider",
	model: "model",
};

export interface ResContext {
	store: EnvStore;
	resources: ResourceStore;
	history: HistoryIndex;
	json: boolean;
	/** 目标环境：--env > 免切换语法 > 当前激活 */
	env: string;
}

function printJson(v: unknown): void {
	console.log(JSON.stringify(v, null, 2));
}

export async function runResourceGroup(
	ctx: ResContext,
	group: ResourceGroup,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
): Promise<number> {
	const kind = GROUP_KIND[group];

	// provider 与 model 共用一组实现（model 为 provider 内实体）
	if (group === "model") {
		return runModelCmds(ctx, action, args);
	}
	if (group === "provider") {
		return runProviderCmds(ctx, action, args, flags);
	}

	switch (action) {
		case "list":
		case "ls": {
			if (flags.get("available") === true) {
				const all = ctx.resources.list().filter((m) => m.kind === kind);
				if (ctx.json) {
					printJson(all);
					return 0;
				}
				console.log(
					table(
						["KIND", "NAME", "VERSION", "SOURCE", "DESCRIPTION"],
						all.map((m) => [m.kind, m.name, m.version, m.source.type, truncate(m.description ?? "", 40)]),
					),
				);
				return 0;
			}
			const res = ctx.store.resolve(ctx.env).effective;
			let items: { name: string; version: string; desc: string }[];
			if (kind === "tool") {
				items = res.tools.custom.map((t) => ({ name: t.name, version: "", desc: t.description }));
			} else {
				const field = (kind === "skill" ? "skills" : kind === "extension" ? "extensions" : "themes") as "skills";
				const list = res[field] as (string | { name: string; version?: string })[];
				items = list.map((s) => ({
					name: typeof s === "string" ? s : s.name,
					version: typeof s === "object" && s.version ? s.version : "",
					desc: "",
				}));
			}
			if (ctx.json) {
				printJson({ env: ctx.env, items });
				return 0;
			}
			console.log(c.dim(`环境 ${ctx.env} 启用的 ${group}：`));
			console.log(
				table(
					["NAME", "VERSION", "DESCRIPTION"],
					items.map((i) => [i.name, i.version || "latest", truncate(i.desc, 44)]),
					[0, 2],
				),
			);
			return 0;
		}

		case "add": {
			const target = args[0];
			if (!target) return usage(`ponda ${group} add <name|本地路径> [--env <env>] [--version <v>]`);

			let name: string;
			if (group === "tools" && typeof flags.get("command") === "string") {
				// 内联 command 工具：ponda tools add deploy --command '...' --desc '...'
				const toolName = target;
				ctx.resources.installCommandTool(
					{
						name: toolName,
						description:
							typeof flags.get("desc") === "string"
								? (flags.get("desc") as string)
								: `command tool: ${toolName}`,
						command: flags.get("command") as string,
					},
					{ force: flags.get("force") === true },
				);
				ctx.resources.enable(ctx.env, "tool", toolName);
				console.log(c.green("✓"), `工具 ${toolName} 已入池并启用（${ctx.env}）`);
				return 0;
			}

			if (target.startsWith("npm:") || target.startsWith("git:")) {
				// registry 安装通道（M2，design: 02 §2/§4）
				name =
					args[1] ??
					target
						.split("/")
						.pop()
						?.replace(/[.#][^/]*$/, "") ??
					"unnamed";
				try {
					const meta = ctx.resources.installFromRegistry(kind, name, target, {
						version: typeof flags.get("version") === "string" ? (flags.get("version") as string) : undefined,
					});
					console.log(
						c.green("✓"),
						`已入池：${meta.kind}/${meta.name}@${meta.version}（来源 ${target.split(":")[0]}）`,
					);
				} catch (e) {
					console.error(`${c.red("registry 安装失败")}：${e instanceof Error ? e.message : String(e)}`);
					return 1;
				}
			} else if (existsSync(target)) {
				name = args[1] ?? target.replace(/\/+$/, "").split("/").pop() ?? "unnamed";
				const meta = ctx.resources.installFromPath(kind, name, target, {
					version: typeof flags.get("version") === "string" ? (flags.get("version") as string) : undefined,
				});
				console.log(c.green("✓"), `已入池：${meta.kind}/${meta.name}@${meta.version}（来源 local）`);
			} else {
				name = target;
				if (ctx.resources.meta(kind, name) === null) {
					console.error(
						`${c.red("未找到")}：池内不存在 ${name}，且不是本地路径或 registry 源（npm:xxx / git:url）。`,
					);
					return 2;
				}
			}
			if (kind === "prompt") {
				console.log(
					c.dim(
						`prompt 无启用清单；在环境中引用：ponda env create/patch 设 identity.systemPrompt = { pool: "${name}" }`,
					),
				);
				return 0;
			}
			ctx.resources.enable(ctx.env, kind, name, {
				version: typeof flags.get("version") === "string" ? (flags.get("version") as string) : undefined,
			});
			console.log(c.green("✓"), `已在 ${ctx.env} 启用 ${group.slice(0, -1)}：${name}`);
			return 0;
		}

		case "rm":
		case "remove": {
			const name = args[0];
			if (!name) return usage(`ponda ${group} rm <name> [--env <env>] [--purge]`);
			if (kind === "prompt") {
				if (flags.get("purge") === true) ctx.resources.remove(kind, name);
				console.log(
					c.green("✓"),
					`prompt ${name}${flags.get("purge") === true ? " 已从池删除" : " 已从池解除引用（--purge 删除实体）"}`,
				);
				return 0;
			}
			ctx.resources.disable(ctx.env, kind, name);
			if (flags.get("purge") === true) {
				const refs = ctx.resources.envReferences(kind, name);
				if (refs.length > 0) {
					console.error(`${c.red("拒绝")}：仍被环境引用 [${refs.join(", ")}]，先在这些环境 rm`);
					return 4;
				}
				ctx.resources.remove(kind, name);
				console.log(c.green("✓"), `${name} 已停用并从池删除`);
			} else {
				console.log(c.green("✓"), `${name} 已在 ${ctx.env} 停用（池保留；--purge 删除实体）`);
			}
			return 0;
		}

		case "update": {
			// 池内更新（registry 类未接入；本版：把 --version 重定向 / 重新装本地路径）
			const name = args[0];
			if (!name) {
				console.log(c.dim("update 需要资源名（registry 拉取通道 M2 后续；本地路径重装：ponda skills add <path>）"));
				return 0;
			}
			if (typeof flags.get("version") === "string") {
				ctx.resources.enable(ctx.env, kind, name, { version: flags.get("version") as string });
				console.log(c.green("✓"), `${name} 版本钉扎为 ${flags.get("version")}（重渲染生效）`);
				return 0;
			}
			console.error("update：无 registry 通道时请用 --version 钉扎或从本地路径重新 add");
			return 1;
		}

		case "info": {
			const name = args[0];
			if (!name) return usage(`ponda ${group} info <name>`);
			const meta = ctx.resources.meta(kind, name);
			if (meta === null) {
				console.error(`池内不存在：${name}`);
				return 2;
			}
			const refs = ctx.resources.envReferences(kind, name);
			if (ctx.json) {
				printJson({ ...meta, envReferences: refs });
				return 0;
			}
			console.log(
				c.bold(`${meta.kind}/${meta.name}@${meta.version}`),
				c.dim(`来源 ${meta.source.type}${meta.source.origin ? ` (${meta.source.origin})` : ""}`),
			);
			if (meta.description) console.log(`描述      : ${meta.description}`);
			console.log(`入口      : ${meta.entry}`);
			console.log(`版本      : ${ctx.resources.versions(kind, name).join(", ") || "-"}`);
			console.log(`引用环境  : ${refs.join(", ") || c.dim("(none)")}`);
			return 0;
		}

		default:
			console.error(`未知动作：${action}。可用：list/add/rm/update/info（--env 指定环境，缺省 ${ctx.env}）`);
			return 1;
	}
}

// —— provider / model ——

const APIS = ["openai-completions", "openai-responses", "anthropic", "google-genai"] as const;

function runProviderCmds(
	ctx: ResContext,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
): number {
	switch (action) {
		case "list":
		case "ls": {
			const res = ctx.store.resolve(ctx.env).effective;
			const providerEntries = Object.entries(res.models.providers ?? {}).filter(
				(d): d is [string, ProviderDef] => d[1] !== null,
			);
			if (providerEntries.length === 0) {
				console.log(c.dim(`环境 ${ctx.env}：无显式 provider（policy=${res.models.policy}，继承全局/内置目录）`));
				return 0;
			}
			console.log(
				table(
					["PROVIDER", "API", "BASE URL", "MODELS", "KEY"],
					providerEntries.map(([name, def]) => [
						name,
						def.api,
						truncate(def.baseUrl, 36),
						def.models.length,
						def.apiKey.startsWith("$") || def.apiKey.startsWith("!") ? c.green(def.apiKey) : c.yellow("明文⚠"),
					]),
					[0, 1, 2, 4],
				),
			);
			return 0;
		}
		case "add": {
			const name = args[0];
			const baseUrl = flags.get("base-url");
			const api = flags.get("api");
			const apiKey = flags.get("api-key") ?? "$OPENAI_API_KEY";
			const models = flags.get("model");
			if (!name || typeof baseUrl !== "string" || typeof api !== "string" || typeof models !== "string") {
				console.error(`用法：ponda provider add <name> --base-url <url> --api <${APIS.join("|")}> --model <id[,id...]> [--api-key <$ENV|!cmd|value>] [--env <env>]
建议优先 --api-key '$ENV_VAR' 或 '!command'，避免明文落盘。`);
				return 1;
			}
			if (!(APIS as readonly string[]).includes(api)) {
				console.error(`--api 非法：${api}（允许：${APIS.join(" | ")}）`);
				return 3;
			}
			const def: ProviderDef = {
				baseUrl,
				api: api as ProviderDef["api"],
				apiKey: String(apiKey),
				models: String(models)
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
					.map((id) => ({ id })),
			};
			ctx.resources.installProviderDef(name, def);
			ctx.resources.enable(ctx.env, "provider", name);
			console.log(c.green("✓"), `provider ${name} 已入池并在 ${ctx.env} 启用（${def.models.length} 个模型）`);
			return 0;
		}
		case "rm": {
			const name = args[0];
			if (!name) return usage("ponda provider rm <name> [--env <env>]");
			ctx.resources.disable(ctx.env, "provider", name);
			console.log(c.green("✓"), `provider ${name} 已在 ${ctx.env} 移除`);
			return 0;
		}
		case "info": {
			const name = args[0];
			if (!name) return usage("ponda provider info <name>");
			const def = ctx.resources.readProviderDef(name);
			if (def === null) {
				console.error(`池内不存在 provider：${name}`);
				return 2;
			}
			printJson(def);
			return 0;
		}
		default:
			console.error("可用动作：list/add/rm/info（交互式向导见 M2 后续，当前为旗标模式）");
			return 1;
	}
}

function runModelCmds(ctx: ResContext, action: string, _args: string[]): number {
	if (action !== "list" && action !== "ls") {
		console.error("model 子命令当前支持：list（模型属 provider 定义，增删改经 ponda provider add/rm）");
		return 1;
	}
	const res = ctx.store.resolve(ctx.env).effective;
	const rows: (string | number)[][] = [];
	for (const [p, defMaybe] of Object.entries(res.models.providers ?? {})) {
		if (defMaybe === null) continue;
		for (const m of defMaybe.models) rows.push([p, m.id, m.thinking === true ? "yes" : "-", m.contextWindow ?? "-"]);
	}
	if (rows.length === 0) {
		console.log(c.dim("无显式模型（继承全局/内置目录；pi --list-models 查看全部）"));
		return 0;
	}
	console.log(table(["PROVIDER", "MODEL", "THINKING", "CTX"], rows, [0, 1]));
	return 0;
}

// —— memory ——

export function runMemory(ctx: ResContext, action: string): number {
	const memDir = join(paths.env(ctx.store.home, ctx.env), "memory");
	const memFile = join(memDir, "MEMORY.md");
	const facts = join(memDir, "facts.json");

	switch (action) {
		case "reset": {
			const trash = join(paths.trash(ctx.store.home), "memory");
			mkdirSync(trash, { recursive: true });
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			for (const f of [memFile, facts]) {
				if (existsSync(f)) renameSync(f, join(trash, `${ctx.env}-${basename2(f)}-${ts}`));
			}
			mkdirSync(memDir, { recursive: true });
			writeFileSync(memFile, "", "utf8");
			console.log(c.green("✓"), `环境 ${ctx.env} 记忆已重置（旧数据在 .trash/memory，7 天内可恢复）`);
			return 0;
		}
		case "list":
		case "info": {
			const text = existsSync(memFile) ? readFileSync(memFile, "utf8") : "";
			const lines = text.split("\n").filter((l) => l.trim().length > 0);
			console.log(
				`环境 ${ctx.env} 记忆：${lines.length} 条 / ${text.length} 字节${existsSync(facts) ? "（含 facts.json）" : ""}`,
			);
			if (lines.length > 0) console.log(c.dim(lines.slice(-5).join("\n")));
			return 0;
		}
		default:
			console.error("用法：ponda memory reset|list|info [--env <env>]");
			return 1;
	}
}

// —— history ——

export function runHistory(
	ctx: ResContext,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
): number {
	switch (action) {
		case "list":
		case "ls": {
			const entries = ctx.history.list({
				env: typeof flags.get("env") === "string" ? (flags.get("env") as string) : undefined,
			});
			if (ctx.json) {
				printJson(entries);
				return 0;
			}
			if (entries.length === 0) {
				console.log(c.dim("暂无会话历史（会话由 pi 产生于各环境 sessions/ 目录）"));
				return 0;
			}
			console.log(
				table(
					["SESSION", "ENV", "TOKENS", "COST", "LAST ACTIVE", "TITLE"],
					entries
						.slice(0, 30)
						.map((e) => [
							e.sessionId.slice(0, 8),
							e.env,
							e.tokens.input + e.tokens.output,
							e.cost || 0,
							e.lastActiveAt.slice(0, 16).replace("T", " "),
							truncate(e.title, 36),
						]),
					[0, 1, 4, 5],
				),
			);
			return 0;
		}
		case "info": {
			const id = args[0];
			if (!id) return usage("ponda history info <session-id>");
			const e = ctx.history.list().find((x) => x.sessionId.startsWith(id) || x.file.includes(id));
			if (!e) {
				console.error("未找到会话");
				return 2;
			}
			printJson(e);
			return 0;
		}
		case "rm": {
			const id = args[0];
			if (!id) return usage("ponda history rm <session-id>");
			const hit = ctx.history.remove(id);
			console.log(c.green("✓"), `已删除会话 ${hit.sessionId.slice(0, 8)}（${hit.env}）`);
			return 0;
		}
		case "attach": {
			const id = args[0];
			if (!id) return usage("ponda history attach <session-id>");
			const info = ctx.history.attachInfo(id);
			console.log(`会话属于环境 ${c.bold(info.env)}：`);
			console.log(c.dim(`  cd <工作区> && ponda pi --resume ${info.file}`));
			if (ctx.store.readState().activeEnv !== info.env) {
				console.log(
					c.yellow(
						`  当前激活环境是 ${ctx.store.readState().activeEnv}，attach 需先：ponda env activate ${info.env}`,
					),
				);
			}
			return 0;
		}
		case "search": {
			const kw = args[0];
			if (!kw) return usage("ponda history search <keyword>");
			const hits = ctx.history.list({ keyword: kw });
			if (hits.length === 0) {
				console.log(c.dim("无命中"));
				return 0;
			}
			console.log(
				table(
					["SESSION", "ENV", "LAST ACTIVE", "TITLE"],
					hits
						.slice(0, 30)
						.map((e) => [
							e.sessionId.slice(0, 8),
							e.env,
							e.lastActiveAt.slice(0, 16).replace("T", " "),
							truncate(e.title, 40),
						]),
					[0, 1, 2, 3],
				),
			);
			return 0;
		}
		default:
			console.error("可用动作：list/info/rm/attach/search（--env 过滤）");
			return 1;
	}
}

function usage(msg: string): number {
	console.error(`${c.red("用法错误")}：${msg}`);
	return 1;
}

function basename2(p: string): string {
	return p.split("/").pop() ?? p;
}

/** 构造资源上下文（目标环境解析：--env > 免切换 > 当前激活） */
export function makeResContext(store: EnvStore, flags: Map<string, string | boolean>, json: boolean): ResContext {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	return {
		store,
		resources: new ResourceStore(store.home, store),
		history: new HistoryIndex(store),
		json,
		env,
	};
}
