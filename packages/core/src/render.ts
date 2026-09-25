/**
 * 渲染器：manifest → pi 消费文件 + 软链接注入（design: 01-environment.md §2.2 / 02-resources.md §3）。
 *
 * 结构：planRender（纯函数，可比较）→ applyRender（落盘，幂等）。
 * doctor 用 plan 与磁盘比对报告漂移。plan 中的 target 为绝对路径；落盘时转为相对链接。
 */
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isCredentialReference, mergeProviderCredentials } from "./auth.ts";
import { ENV_SUBDIRS, paths } from "./paths.ts";
import type { EnvManifest, ProviderDef, ResourceSelector } from "./types.ts";
import { isExclusionSelector, selectorName } from "./validate.ts";

const DEFAULT_SYSTEM_PROMPT = "You are a helpful coding agent.";

export interface PlannedFile {
	/** 相对 env dir */
	path: string;
	content: string;
}

export interface PlannedSymlink {
	/** 相对 env dir（链接位置，如 skills/react） */
	path: string;
	/** 资源池目标的绝对路径 */
	target: string;
}

export interface RenderPlan {
	files: PlannedFile[];
	symlinks: PlannedSymlink[];
	/** 本轮不应存在、需要清理的旧渲染产物（相对路径） */
	removed: string[];
	/** manifest 中的明文凭据（provider → key）：models.json 剥离，落 auth.json（0600） */
	credentials: Record<string, string>;
	warnings: string[];
}

export interface RenderResult extends RenderPlan {
	dir: string;
}

function substituteVars(text: string, name: string): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: manifest 模板变量占位符，非 JS 模板
	return text.replaceAll("${env.name}", name);
}

/** 解析 system prompt 为最终文本；池引用缺失时降级默认值并告警 */
function resolveSystemPrompt(
	sp: EnvManifest["identity"]["systemPrompt"],
	home: string,
	name: string,
	warnings: string[],
): string {
	let text: string;
	if (typeof sp === "string") {
		text = sp;
	} else {
		const poolFile = join(paths.resource(home, "prompts", sp.pool), "PROMPT.md");
		if (existsSync(poolFile)) {
			text = readFileSync(poolFile, "utf8");
		} else {
			warnings.push(`prompt 池引用不存在：resources/prompts/${sp.pool}/PROMPT.md，回退默认 system prompt`);
			text = DEFAULT_SYSTEM_PROMPT;
		}
	}
	return substituteVars(text, name);
}

const KIND_TO_DIR: Record<"skills" | "extensions" | "themes", string> = {
	skills: "skills",
	extensions: "extensions",
	themes: "themes",
};

/** 池内目录名版本比较（与 resources.ts 的 compareVersions 同义，避免渲染层反向依赖） */
function compareDirVersions(a: string, b: string): number {
	const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** 为选择器定位资源池目标：精确版本 > 裸名目录 > name@* 中最高版本；返回绝对路径或 null */
function poolTarget(home: string, kindPlural: string, sel: ResourceSelector): string | null {
	const name = selectorName(sel);
	if (typeof sel !== "string" && "version" in sel) {
		// 钉扎版本：严格匹配，不回落
		const versioned = paths.resource(home, kindPlural, `${name}@${sel.version}`);
		return existsSync(versioned) ? versioned : null;
	}
	const plain = paths.resource(home, kindPlural, name);
	if (existsSync(plain)) return plain;
	const dir = join(paths.resources(home), kindPlural);
	if (existsSync(dir)) {
		const cands = readdirSync(dir)
			.filter((d) => d.startsWith(`${name}@`))
			.map((d) => d.slice(name.length + 1))
			.sort(compareDirVersions);
		if (cands.length > 0) return join(dir, `${name}@${cands[cands.length - 1]}`);
	}
	return null;
}

/** 纯函数：计算渲染计划（只做只读 existsSync 探测，不写盘） */
export function planRender(home: string, name: string, env: EnvManifest): RenderPlan {
	const warnings: string[] = [];
	const files: PlannedFile[] = [];
	const symlinks: PlannedSymlink[] = [];
	const removed: string[] = [];
	const credentials: Record<string, string> = {};

	// settings.json —— skills/extensions/themes 目录由 pi 的 resource-loader 自动扫描，
	// settings 只声明主题与技能命令开关
	const settings: Record<string, unknown> = { enableSkillCommands: true };
	if (env.activeTheme) settings.theme = env.activeTheme;
	files.push({ path: "settings.json", content: `${JSON.stringify(settings, null, "\t")}\n` });

	files.push({
		path: "SYSTEM.md",
		content: resolveSystemPrompt(env.identity.systemPrompt, home, name, warnings),
	});
	if (env.identity.appendSystemPrompt && env.identity.appendSystemPrompt.length > 0) {
		files.push({ path: "APPEND_SYSTEM.md", content: substituteVars(env.identity.appendSystemPrompt, name) });
	} else {
		removed.push("APPEND_SYSTEM.md");
	}

	if (env.models.policy === "explicit" && env.models.providers && Object.keys(env.models.providers).length > 0) {
		// 凭据分离（02 §6.1）：引用形式（$ENV/!command）随 models.json 交付（pi 原生解析）；
		// 明文剥离进 credentials → auth.json（0600），绝不写入渲染产物
		const providers: Record<string, ProviderDef> = {};
		for (const [k, v] of Object.entries(env.models.providers)) {
			if (v === null) continue;
			if (v.apiKey !== undefined && isCredentialReference(v.apiKey)) {
				providers[k] = v;
			} else {
				if (v.apiKey !== undefined && v.apiKey.length > 0) {
					credentials[k] = v.apiKey;
					warnings.push(
						`provider "${k}" 的明文 apiKey 已剥离到 auth.json（建议 manifest 改用 $ENV_VAR/!command 引用；ponda doctor 可自动迁移）`,
					);
				}
				const { apiKey: _stripped, ...rest } = v;
				void _stripped;
				providers[k] = rest as ProviderDef;
			}
		}
		files.push({ path: "models.json", content: `${JSON.stringify({ providers }, null, "\t")}\n` });
	} else {
		removed.push("models.json");
	}

	if (Object.keys(env.mcp).length > 0) {
		files.push({ path: "mcp.json", content: `${JSON.stringify({ mcpServers: env.mcp }, null, "\t")}\n` });
	} else {
		removed.push("mcp.json");
	}

	if (env.keybindings && Object.keys(env.keybindings).length > 0) {
		files.push({ path: "keybindings.json", content: `${JSON.stringify(env.keybindings, null, "\t")}\n` });
	} else {
		removed.push("keybindings.json");
	}

	// 软链接注入：资源池 → 环境目录（私有 path 选择器不注入；池中不存在的记 warning）
	for (const [kindField, dirName] of Object.entries(KIND_TO_DIR) as [keyof typeof KIND_TO_DIR, string][]) {
		for (const sel of env[kindField]) {
			if (isExclusionSelector(sel)) continue; // 有效配置不应出现，防御
			const resName = selectorName(sel);
			if (typeof sel !== "string" && "path" in sel) continue; // 私有资源
			const target = poolTarget(home, dirName, sel);
			if (target === null) {
				warnings.push(`资源池中不存在：${dirName}/${resName}（环境 ${name}）`);
				continue;
			}
			symlinks.push({ path: join(dirName, resName), target });
		}
	}

	return { files, symlinks, removed, credentials, warnings };
}

function writeFileAtomic(abs: string, content: string): void {
	mkdirSync(dirname(abs), { recursive: true });
	const tmp = `${abs}.ponda-tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, abs);
}

/** 落盘执行（幂等）：确保目录、写文件、重建受管软链接、清理受管孤儿链接与被移除产物 */
export function applyRender(home: string, name: string, plan: RenderPlan): RenderResult {
	const envDir = paths.env(home, name);
	for (const sub of ENV_SUBDIRS) {
		mkdirSync(join(envDir, sub), { recursive: true });
	}

	for (const f of plan.files) {
		writeFileAtomic(join(envDir, f.path), f.content);
	}
	for (const rel of plan.removed) {
		const abs = join(envDir, rel);
		if (existsSync(abs)) rmSync(abs);
	}

	// 明文凭据合并进 auth.json（0600；仅当内容变化才写盘，用户手工条目保留）
	mergeProviderCredentials(home, name, plan.credentials);

	// 受管软链接：只碰"符号链接"；真实文件/目录（私有资源）永不触碰
	for (const link of plan.symlinks) {
		const linkDir = join(envDir, dirname(link.path));
		mkdirSync(linkDir, { recursive: true });
		const absLink = join(envDir, link.path);
		const relTarget = isAbsolute(link.target) ? relative(linkDir, link.target) : link.target;
		try {
			// rmSync 对"指向目录的符号链接"需 recursive（不会解引用进目标）
			if (lstatSync(absLink).isSymbolicLink()) rmSync(absLink, { force: true, recursive: true });
		} catch {
			// 不存在则直接创建
		}
		const linkName = link.path.split("/").pop() as string;
		const tmpLink = join(linkDir, `.ponda-link-${linkName}`);
		symlinkSync(relTarget, tmpLink);
		renameSync(tmpLink, absLink);
	}

	// 清理孤儿受管链接：资源目录内不在计划中的符号链接、且其解析目标位于资源池内
	const resourcesDir = paths.resources(home);
	for (const dirName of Object.values(KIND_TO_DIR)) {
		const dir = join(envDir, dirName);
		if (!existsSync(dir)) continue;
		const planned = new Set(plan.symlinks.filter((l) => l.path.startsWith(`${dirName}/`)).map((l) => l.path));
		for (const entry of readdirSync(dir)) {
			const rel = `${dirName}/${entry}`;
			if (planned.has(rel)) continue;
			const abs = join(dir, entry);
			try {
				if (!lstatSync(abs).isSymbolicLink()) continue;
				const raw = readlinkSync(abs);
				const resolved = isAbsolute(raw) ? raw : join(dir, raw);
				if (resolved.startsWith(resourcesDir)) rmSync(abs, { force: true, recursive: true });
			} catch {
				// 断链等异常留给 doctor 报告
			}
		}
	}

	return { ...plan, dir: envDir };
}

export function renderEnv(home: string, name: string, env: EnvManifest): RenderResult {
	return applyRender(home, name, planRender(home, name, env));
}
