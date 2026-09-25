/**
 * 资源池与"两级模型"（池 → 环境启用清单）管理（design: 02-resources.md）。
 *
 * 池内布局：<home>/resources/<kindPlural>/<name>@<version>/ + resource.json
 * 环境启用：skill/extension/theme → manifest 列表（渲染时软链接注入）；
 *          tool → manifest.tools.custom；provider/model → manifest.models；mcp-server → manifest.mcp。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "./paths.ts";
import type { EnvStore } from "./store.ts";
import type { CommandTool, EnvManifestInput, ProviderDef, ResourceKind, ResourceSelector } from "./types.ts";
import { validateManifestInput } from "./validate.ts";

export interface ResourceMeta {
	kind: ResourceKind;
	name: string;
	version: string;
	source: { type: "builtin" | "registry" | "local"; origin?: string; digest?: string };
	description?: string;
	entry: string;
	installedAt: string;
	updatedAt: string;
}

const KIND_PLURAL: Record<ResourceKind, string> = {
	skill: "skills",
	tool: "tools",
	prompt: "prompts",
	extension: "extensions",
	theme: "themes",
	provider: "models",
	model: "models",
	"mcp-server": "mcp",
};

/** 可经环境启用清单注入的类别（prompts 经 systemPrompt 引用，provider/model/mcp 走专属节） */
const SELECTOR_KINDS: ResourceKind[] = ["skill", "extension", "theme"];

export function kindPlural(kind: ResourceKind): string {
	return KIND_PLURAL[kind];
}

function dirName(name: string, version: string): string {
	return `${name}@${version}`;
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

export class ResourceStore {
	private readonly home: string;
	private readonly envStore: EnvStore;

	constructor(home: string, envStore: EnvStore) {
		this.home = home;
		this.envStore = envStore;
	}

	// —— 池操作 ——

	poolDir(kind: ResourceKind): string {
		return join(paths.resources(this.home), KIND_PLURAL[kind]);
	}

	versions(kind: ResourceKind, name: string): string[] {
		const dir = this.poolDir(kind);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((d) => d.startsWith(`${name}@`))
			.map((d) => d.slice(name.length + 1))
			.sort(compareVersions);
	}

	latestVersion(kind: ResourceKind, name: string): string | null {
		const vs = this.versions(kind, name);
		return vs.length > 0 ? vs[vs.length - 1] : null;
	}

	/** 池内全部资源（每 name 取最新版） */
	list(): ResourceMeta[] {
		const out: ResourceMeta[] = [];
		const root = paths.resources(this.home);
		if (!existsSync(root)) return out;
		for (const [plural, names] of Object.entries(groupDirsByMeta(root))) {
			for (const name of [...names].sort()) {
				const version = this.latestVersionByPlural(plural, name);
				if (!version) continue;
				const meta = this.readMetaByPlural(plural, name, version);
				if (meta) out.push(meta);
			}
		}
		return out;
	}

	meta(kind: ResourceKind, name: string, version?: string): ResourceMeta | null {
		const v = version ?? this.latestVersion(kind, name);
		if (v === null) return null;
		return this.readMetaByPlural(KIND_PLURAL[kind], name, v);
	}

	/** 从本地路径装入池（registry/npm/git 通道属后续；builtin 由发行版携带） */
	installFromPath(
		kind: ResourceKind,
		name: string,
		srcPath: string,
		opts: { version?: string; description?: string } = {},
	): ResourceMeta {
		if (!existsSync(srcPath)) throw new Error(`源路径不存在：${srcPath}`);
		const version = opts.version ?? "0.1.0";
		const dest = join(this.poolDir(kind), dirName(name, version));
		if (existsSync(dest)) throw new Error(`池内已存在：${KIND_PLURAL[kind]}/${name}@${version}`);
		mkdirSync(dest, { recursive: true });
		cpSync(srcPath, dest, { recursive: true });

		const entry = guessEntry(kind, dest);
		const meta: ResourceMeta = {
			kind,
			name,
			version,
			source: { type: "local", origin: srcPath, digest: digestDir(dest) },
			description: opts.description ?? guessDescription(kind, dest),
			entry,
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeAtomic(join(dest, "resource.json"), JSON.stringify(meta, null, "\t"));
		return meta;
	}

	/**
	 * registry 安装通道（M2 余项，design: 02 §2/§4）：
	 * - npm:<pkg>[@version] → npm pack 下载解包
	 * - git:<url>[#ref]     → git clone --depth 1
	 * - 本地路径直接拷贝
	 */
	installFromRegistry(
		kind: ResourceKind,
		name: string,
		source: string,
		opts: { version?: string; description?: string } = {},
	): ResourceMeta {
		const tmp = mkdtempSync(join(tmpdir(), "ponda-reg-"));
		let srcDir: string;
		let originType: "registry" | "local" = "registry";
		try {
			if (source.startsWith("npm:")) {
				const spec = source.slice(4);
				const r = spawnSync("npm", ["pack", spec, "--pack-destination", tmp], {
					encoding: "utf8",
					timeout: 120000,
				});
				if (r.status !== 0) throw new Error(`npm pack 失败：${(r.stderr ?? "").slice(0, 200)}`);
				const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
				if (tgz === undefined) throw new Error("npm pack 未产出 tgz");
				spawnSync("tar", ["xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
				srcDir = join(tmp, "package");
				if (!existsSync(srcDir)) throw new Error("npm 包解压后无 package/ 目录");
			} else if (source.startsWith("git:")) {
				const url = source.split("#")[0]?.slice(4) as string;
				const ref = source.includes("#") ? (source.split("#")[1] as string) : undefined;
				const args = ["clone", "--depth", "1"];
				if (ref !== undefined) args.push("--branch", ref);
				args.push(url, join(tmp, "repo"));
				const r = spawnSync("git", args, { encoding: "utf8", timeout: 120000 });
				if (r.status !== 0) throw new Error(`git clone 失败：${(r.stderr ?? "").slice(0, 200)}`);
				srcDir = join(tmp, "repo");
			} else if (existsSync(source)) {
				srcDir = source;
				originType = "local";
			} else {
				throw new Error(`无法解析来源：${source}（支持 npm:<pkg>、git:<url>、本地路径）`);
			}

			const version = opts.version ?? "0.1.0";
			const dest = join(this.poolDir(kind), dirName(name, version));
			if (existsSync(dest)) throw new Error(`池内已存在：${KIND_PLURAL[kind]}/${name}@${version}`);
			mkdirSync(dest, { recursive: true });
			cpSync(srcDir, dest, { recursive: true });

			const meta: ResourceMeta = {
				kind,
				name,
				version,
				source: { type: originType, origin: source, digest: this.digestDirectory(dest) },
				description: opts.description,
				entry: guessEntry(kind, dest),
				installedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			writeAtomic(join(dest, "resource.json"), JSON.stringify(meta, null, "\t"));
			return meta;
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	private digestDirectory(dir: string): string {
		const hash = createHash("sha256");
		const walk = (d: string, prefix: string): void => {
			for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
				const abs = join(d, e.name);
				if (e.isDirectory()) {
					walk(abs, `${prefix}${e.name}/`);
				} else {
					hash.update(`${prefix}${e.name}`);
					hash.update(readFileSync(abs));
				}
			}
		};
		walk(dir, "");
		return hash.digest("hex").slice(0, 16);
	}

	/** 注册 command 型工具（tool.json 写入池） */
	installCommandTool(tool: CommandTool, opts: { version?: string; force?: boolean } = {}): ResourceMeta {
		const version = opts.version ?? "0.1.0";
		const dest = join(this.poolDir("tool"), dirName(tool.name, version));
		if (existsSync(dest)) {
			if (!opts.force) throw new Error(`池内已存在：tools/${tool.name}@${version}（--force 覆盖）`);
			rmSync(dest, { recursive: true, force: true });
		}
		mkdirSync(dest, { recursive: true });
		writeAtomic(join(dest, "tool.json"), JSON.stringify(tool, null, "\t"));
		const meta: ResourceMeta = {
			kind: "tool",
			name: tool.name,
			version,
			source: { type: "local", origin: "inline", digest: digestDir(dest) },
			description: tool.description,
			entry: "tool.json",
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeAtomic(join(dest, "resource.json"), JSON.stringify(meta, null, "\t"));
		return meta;
	}

	/** 注册 provider/model 定义（单 JSON 文件入池） */
	installProviderDef(providerName: string, def: ProviderDef): ResourceMeta {
		const dest = join(this.poolDir("provider"), dirName(providerName, def.api));
		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
		mkdirSync(dest, { recursive: true });
		writeAtomic(join(dest, "provider.json"), JSON.stringify(def, null, "\t"));
		const meta: ResourceMeta = {
			kind: "provider",
			name: providerName,
			version: "1.0.0",
			source: { type: "local", origin: "inline" },
			description: `${def.api} · ${def.baseUrl} · ${def.models.length} models`,
			entry: "provider.json",
			installedAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		writeAtomic(join(dest, "resource.json"), JSON.stringify(meta, null, "\t"));
		return meta;
	}

	readProviderDef(providerName: string): ProviderDef | null {
		const vs = this.versions("provider", providerName);
		if (vs.length === 0) return null;
		const f = join(this.poolDir("provider"), dirName(providerName, vs[vs.length - 1]), "provider.json");
		return JSON.parse(readFileSync(f, "utf8")) as ProviderDef;
	}

	/** 从池删除某版本；无环境引用才能删（--purge 由调用方检查） */
	remove(kind: ResourceKind, name: string, version?: string): void {
		const v = version ?? this.latestVersion(kind, name);
		if (v === null) throw new Error(`池内不存在：${name}`);
		rmSync(join(this.poolDir(kind), dirName(name, v)), { recursive: true, force: true });
	}

	// —— 环境启用/停用（写 manifest 差量 + 重渲染） ——

	enable(envName: string, kind: ResourceKind, name: string, opts: { version?: string } = {}): void {
		const m = this.envStore.readManifest(envName);
		if (m === null) throw new Error(`environment not found: ${envName}`);
		const next: EnvManifestInput = { ...m };

		if (SELECTOR_KINDS.includes(kind)) {
			const field = kind === "skill" ? "skills" : kind === "extension" ? "extensions" : "themes";
			const list = [...(next[field] ?? [])].filter((s) => selectorNameOf(s) !== name);
			list.push(opts.version ? { name, version: opts.version } : name);
			next[field] = list as ResourceSelector[];
		} else if (kind === "tool") {
			const tool = this.readTool(name);
			if (tool === null) throw new Error(`池内不存在工具：${name}`);
			const customs = [
				...((next.tools?.custom ?? []) as (CommandTool | { name: string; delete: true })[]).filter(
					(c) => !("delete" in c) && c.name !== name && !("delete" in c && c.name === name),
				),
			].filter((c) => !(c as { delete?: true }).delete);
			customs.push(tool);
			next.tools = { ...(next.tools ?? {}), custom: customs };
		} else if (kind === "provider" || kind === "model") {
			const def = this.readProviderDef(name);
			if (def === null) throw new Error(`池内不存在 provider：${name}`);
			const models = next.models?.policy === "explicit" ? { ...(next.models.providers ?? {}) } : {};
			models[name] = def;
			next.models = { policy: "explicit", providers: models };
		} else if (kind === "mcp-server") {
			throw new Error("mcp-server 经 ponda env create/patch 或 manifest.mcp 配置（无池安装形态）");
		} else if (kind === "prompt") {
			throw new Error("prompt 经 identity.systemPrompt { pool: <name> } 引用（无启用清单）");
		}

		const errors = validateManifestInput(next);
		if (errors.length > 0) throw new Error(`manifest 校验失败：${errors.join("；")}`);
		next.updatedAt = new Date().toISOString();
		this.envStore.saveManifest(next);
		this.envStore.rerender(envName);
	}

	disable(envName: string, kind: ResourceKind, name: string): void {
		const m = this.envStore.readManifest(envName);
		if (m === null) throw new Error(`environment not found: ${envName}`);
		const next: EnvManifestInput = { ...m };

		if (SELECTOR_KINDS.includes(kind)) {
			const field = kind === "skill" ? "skills" : kind === "extension" ? "extensions" : "themes";
			const list = (next[field] ?? []) as ResourceSelector[];
			next[field] = list.filter((s) => selectorNameOf(s) !== name) as ResourceSelector[];
		} else if (kind === "tool") {
			const customs = (next.tools?.custom ?? []) as (CommandTool | { name: string; delete: true })[];
			const existing = customs.filter((c) => !("delete" in c) && c.name === name);
			if (existing.length > 0) {
				next.tools = { ...(next.tools ?? {}), custom: customs.filter((c) => !("delete" in c) && c.name !== name) };
			} else {
				// 继承自父环境：用删除条目覆盖
				next.tools = { ...(next.tools ?? {}), custom: [...customs, { name, delete: true }] };
			}
		} else if (kind === "provider" || kind === "model") {
			const providers = { ...(next.models?.providers ?? {}) };
			providers[name] = null; // null = 从父环境删除
			next.models = { ...(next.models ?? { policy: "inherit-global" }), providers };
		} else {
			throw new Error("该类别不支持环境停用");
		}

		next.updatedAt = new Date().toISOString();
		this.envStore.saveManifest(next);
		this.envStore.rerender(envName);
	}

	readTool(name: string): CommandTool | null {
		const v = this.latestVersion("tool", name);
		if (v === null) return null;
		const f = join(this.poolDir("tool"), dirName(name, v), "tool.json");
		if (!existsSync(f)) return null;
		return JSON.parse(readFileSync(f, "utf8")) as CommandTool;
	}

	/** 哪些环境启用了某资源（rm --purge 前置检查） */
	envReferences(kind: ResourceKind, name: string): string[] {
		return this.envStore.names().filter((env) => {
			const e = this.envStore.resolve(env).effective;
			if (SELECTOR_KINDS.includes(kind)) {
				const field = kind === "skill" ? "skills" : kind === "extension" ? "extensions" : "themes";
				return (e[field] as ResourceSelector[]).some((s) => selectorNameOf(s) === name);
			}
			if (kind === "tool") return e.tools.custom.some((t) => t.name === name);
			if (kind === "provider" || kind === "model") return e.models.providers?.[name] !== undefined;
			return false;
		});
	}

	// —— 内部 ——

	private latestVersionByPlural(plural: string, name: string): string | null {
		const dir = join(paths.resources(this.home), plural);
		if (!existsSync(dir)) return null;
		const vs = readdirSync(dir)
			.filter((d) => d.startsWith(`${name}@`))
			.map((d) => d.slice(name.length + 1))
			.sort(compareVersions);
		return vs.length > 0 ? vs[vs.length - 1] : null;
	}

	private readMetaByPlural(plural: string, name: string, version: string): ResourceMeta | null {
		const f = join(paths.resources(this.home), plural, dirName(name, version), "resource.json");
		if (!existsSync(f)) return null;
		try {
			return JSON.parse(readFileSync(f, "utf8")) as ResourceMeta;
		} catch {
			return null;
		}
	}
}

function selectorNameOf(s: ResourceSelector): string {
	return typeof s === "string" ? s : s.name;
}

function groupDirsByMeta(root: string): Record<string, Set<string>> {
	// 返回 plural -> names（去掉 @version 后去重）
	const result: Record<string, Set<string>> = {};
	for (const plural of readdirSync(root, { withFileTypes: true })) {
		if (!plural.isDirectory()) continue;
		const names = new Set<string>();
		const dir = join(root, plural.name);
		for (const d of readdirSync(dir, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const at = d.name.lastIndexOf("@");
			if (at <= 0) continue;
			if (existsSync(join(dir, d.name, "resource.json"))) {
				names.add(d.name.slice(0, at));
			}
		}
		if (names.size > 0) result[plural.name] = names;
	}
	return result;
}

function guessEntry(kind: ResourceKind, dest: string): string {
	const candidates: Record<string, string> = {
		skill: "SKILL.md",
		extension: "index.ts",
		theme: "", // 主题文件名=主题名，install 后由目录内唯一 .json 充当
		prompt: "PROMPT.md",
	};
	const c = candidates[kind];
	if (c && existsSync(join(dest, c))) return c;
	const files = readdirSync(dest).filter((f) => !f.startsWith("resource."));
	return files[0] ?? "";
}

function guessDescription(kind: ResourceKind, dest: string): string | undefined {
	if (kind === "prompt" || kind === "skill") {
		const f = join(dest, kind === "skill" ? "SKILL.md" : "PROMPT.md");
		if (existsSync(f)) {
			const text = readFileSync(f, "utf8");
			const m = text.match(/description:\s*(.+)/);
			if (m) return m[1].trim().slice(0, 100);
		}
	}
	return undefined;
}

function digestDir(dir: string): string {
	const hash = createHash("sha256");
	for (const f of readdirSync(dir).sort()) {
		hash.update(f);
		hash.update(readFileSync(join(dir, f)));
	}
	return hash.digest("hex").slice(0, 16);
}

function writeAtomic(file: string, content: string): void {
	mkdirSync(join(file, ".."), { recursive: true });
	const tmp = `${file}.ponda-tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}
