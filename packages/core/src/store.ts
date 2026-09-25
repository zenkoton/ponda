/**
 * EnvStore：环境生命周期与全局运行态（design: 01-environment.md §4/§5）。
 * state.json / manifest.json 写入均为 原子写（tmp + rename）；删除走 .trash 回收站。
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ENV_SUBDIRS, paths, pondaHome } from "./paths.ts";
import { planRender, renderEnv } from "./render.ts";
import { EnvNotFoundError, type ResolvedEnv, resolveEnv } from "./resolve.ts";
import type { EnvManifestInput, EnvSummary, PondaState } from "./types.ts";
import { validateEnvName, validateManifestInput } from "./validate.ts";

export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}

export interface CreateEnvOptions {
	name: string;
	base?: string;
	description?: string;
	systemPrompt?: string;
	/** 差量字段（skills/extensions/...），仅写入用户显式声明的部分 */
	patch?: EnvManifestInput;
}

export class EnvStore {
	readonly home: string;

	constructor(home: string) {
		this.home = home;
	}

	static defaultHome(): string {
		return pondaHome();
	}

	// —— 基础读写 ——

	exists(name: string): boolean {
		return existsSync(paths.envManifest(this.home, name));
	}

	names(): string[] {
		const dir = paths.envs(this.home);
		if (!existsSync(dir)) return [];
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json")))
			.map((e) => e.name)
			.sort();
	}

	readManifest(name: string): EnvManifestInput | null {
		const file = paths.envManifest(this.home, name);
		if (!existsSync(file)) return null;
		try {
			return JSON.parse(readFileSync(file, "utf8")) as EnvManifestInput;
		} catch (e) {
			throw new ValidationError(`manifest.json 解析失败（${name}）：${(e as Error).message}`);
		}
	}

	private writeManifest(name: string, input: EnvManifestInput): void {
		const errors = validateManifestInput(input);
		if (errors.length > 0) throw new ValidationError(`manifest 校验失败（${name}）：\n  - ${errors.join("\n  - ")}`);
		const file = paths.envManifest(this.home, name);
		mkdirSync(dirnameOf(file), { recursive: true });
		writeAtomic(file, `${JSON.stringify(input, null, "\t")}\n`);
	}

	resolve(name: string): ResolvedEnv {
		return resolveEnv((n) => this.readManifest(n), name);
	}

	/** 公开受控写入口（resources 等模块经校验后调用；input.name 决定目标环境） */
	saveManifest(input: EnvManifestInput): void {
		const name = input.name;
		if (name === undefined) throw new ValidationError("saveManifest 需要 input.name");
		this.writeManifest(name, input);
	}

	/** 重渲染指定环境 */
	rerender(name: string): void {
		const res = this.resolve(name);
		renderEnv(this.home, name, res.effective);
	}

	// —— 全局运行态 state.json ——
	readState(): PondaState {
		const file = paths.state(this.home);
		if (!existsSync(file)) return { activeEnv: null };
		try {
			const s = JSON.parse(readFileSync(file, "utf8")) as PondaState;
			return { ...s, activeEnv: s.activeEnv ?? null };
		} catch {
			return { activeEnv: null };
		}
	}

	private writeState(state: PondaState): void {
		mkdirSync(this.home, { recursive: true });
		writeAtomic(paths.state(this.home), `${JSON.stringify(state, null, "\t")}\n`);
	}

	// —— 生命周期 ——

	create(opts: CreateEnvOptions): ResolvedEnv {
		const nameErrors = validateEnvName(opts.name);
		if (nameErrors.length > 0) throw new ValidationError(nameErrors.join("；"));
		if (this.exists(opts.name)) throw new ValidationError(`环境已存在：${opts.name}`);

		const base = opts.base ?? "default";
		if (base !== opts.name && !(base === "default" && !this.exists("default"))) {
			if (!this.exists(base)) throw new EnvNotFoundError(base);
		}

		const input: EnvManifestInput = {
			schemaVersion: 1,
			name: opts.name,
			...(opts.base !== undefined ? { base: opts.base } : {}),
			...(opts.description !== undefined ? { description: opts.description } : {}),
			...(opts.systemPrompt !== undefined ? { identity: { systemPrompt: opts.systemPrompt } } : {}),
			...(opts.patch ?? {}),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		// 环境校验 + 继承链完整性（含成环检测）
		const errors = validateManifestInput(input);
		if (errors.length > 0) throw new ValidationError(errors.join("；"));
		const resolved = resolveEnv((n) => (n === opts.name ? input : this.readManifest(n)), opts.name);

		this.writeManifest(opts.name, input);
		renderEnv(this.home, opts.name, resolved.effective);
		return resolved;
	}

	remove(name: string, opts: { force?: boolean } = {}): void {
		if (!this.exists(name)) throw new EnvNotFoundError(name);
		const state = this.readState();
		if (state.activeEnv === name) {
			throw new ValidationError(`环境 ${name} 是当前激活环境，请先 ponda env activate 其他环境或 deactivate`);
		}

		// 被 base 引用的环境：默认拒绝；--force 时将引用方改继被删环境的父级
		const referrers = this.names().filter((n) => this.readManifest(n)?.base === name);
		if (referrers.length > 0 && !opts.force) {
			throw new ValidationError(
				`环境 ${name} 被以下环境继承：${referrers.join(", ")}；使用 --force 将其改继 ${name} 的父级`,
			);
		}
		const removedBase = this.readManifest(name)?.base;
		for (const r of referrers) {
			const m = this.readManifest(r) as EnvManifestInput;
			const next: EnvManifestInput = { ...m };
			if (removedBase === undefined || removedBase === "default") delete next.base;
			else next.base = removedBase;
			next.updatedAt = new Date().toISOString();
			this.writeManifest(r, next);
			const res = this.resolve(r);
			renderEnv(this.home, r, res.effective);
		}

		const envDir = paths.env(this.home, name);
		if (opts.force) {
			rmSync(envDir, { recursive: true, force: true });
		} else {
			const trashDir = join(paths.trash(this.home), "envs");
			mkdirSync(trashDir, { recursive: true });
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			renameSync(envDir, join(trashDir, `${name}-${ts}`));
		}
	}

	rename(oldName: string, newName: string): void {
		if (!this.exists(oldName)) throw new EnvNotFoundError(oldName);
		const nameErrors = validateEnvName(newName);
		if (nameErrors.length > 0) throw new ValidationError(nameErrors.join("；"));
		if (this.exists(newName)) throw new ValidationError(`环境已存在：${newName}`);

		const m = this.readManifest(oldName) as EnvManifestInput;
		m.name = newName;
		m.updatedAt = new Date().toISOString();
		const state = this.readState();
		mkdirSync(paths.env(this.home, newName), { recursive: true });
		// 移动全部内容（manifest、私有资源、会话），再重渲染（软链接为相对路径，随目录平移仍有效）
		for (const entry of readdirSync(paths.env(this.home, oldName))) {
			renameSync(join(paths.env(this.home, oldName), entry), join(paths.env(this.home, newName), entry));
		}
		rmSync(paths.env(this.home, oldName), { recursive: true, force: true });
		this.writeManifest(newName, m);
		const res = this.resolve(newName);
		renderEnv(this.home, newName, res.effective);

		if (state.activeEnv === oldName) this.activate(newName);
		// 引用方 base 更名
		for (const n of this.names()) {
			const nm = this.readManifest(n);
			if (nm?.base === oldName) {
				nm.base = newName;
				nm.updatedAt = new Date().toISOString();
				this.writeManifest(n, nm);
				renderEnv(this.home, n, this.resolve(n).effective);
			}
		}
	}

	activate(name: string): ResolvedEnv {
		if (!this.exists(name)) throw new EnvNotFoundError(name);
		const resolved = this.resolve(name);
		renderEnv(this.home, name, resolved.effective);

		const state = this.readState();
		this.writeState({ ...state, activeEnv: name, activatedAt: new Date().toISOString() });
		writeAtomic(paths.envActivatedAt(this.home, name), `${new Date().toISOString()}\n`);
		return resolved;
	}

	deactivate(): void {
		const state = this.readState();
		this.writeState({ ...state, activeEnv: null, activatedAt: new Date().toISOString() });
	}

	/** 记录工作区本地绑定（state.json perWorkspace；design: 01 §7.2） */
	bindWorkspace(wsRoot: string, env: string): void {
		const state = this.readState();
		const per = { ...(state.perWorkspace ?? {}) };
		per[wsRoot] = env;
		this.writeState({ ...state, perWorkspace: per });
	}

	unbindWorkspace(wsRoot: string): void {
		const state = this.readState();
		if (!state.perWorkspace) return;
		const per = { ...state.perWorkspace };
		delete per[wsRoot];
		this.writeState({ ...state, perWorkspace: per });
	}

	list(): EnvSummary[] {
		const active = this.readState().activeEnv;
		return this.names().map((name) => {
			const res = this.resolve(name);
			const m = res.effective;
			const sessionsDir = join(paths.env(this.home, name), "sessions");
			let sessionCount = 0;
			if (existsSync(sessionsDir)) {
				sessionCount = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")).length;
			}
			let lastActivatedAt: string | undefined;
			const actFile = paths.envActivatedAt(this.home, name);
			if (existsSync(actFile)) lastActivatedAt = readFileSync(actFile, "utf8").trim();
			return {
				name,
				base: this.readManifest(name)?.base,
				description: m.description,
				skillCount: m.skills.length,
				extensionCount: m.extensions.length,
				themeCount: m.themes.length,
				sessionCount,
				updatedAt: m.updatedAt,
				lastActivatedAt,
				active: active === name,
			};
		});
	}

	diff(a: string, b: string): { path: string; a?: unknown; b?: unknown }[] {
		const ra = this.resolve(a).effective;
		const rb = this.resolve(b).effective;
		const strip = (m: Record<string, unknown>): Record<string, unknown> => {
			const { name: _n, createdAt: _c, updatedAt: _u, ...rest } = m;
			return rest;
		};
		return diffRecords(strip(JSON.parse(JSON.stringify(ra))), strip(JSON.parse(JSON.stringify(rb))), "");
	}

	// —— 导入导出（design: 01 §4.4） ——

	exportEnv(name: string, outDir: string): void {
		if (!this.exists(name)) throw new EnvNotFoundError(name);
		const envDir = paths.env(this.home, name);
		mkdirSync(outDir, { recursive: true });
		cpSync(join(envDir, "manifest.json"), join(outDir, "manifest.json"));
		// 私有资源（非符号链接内容）与私有 prompt 一并拷贝
		for (const sub of ["skills", "extensions", "themes", "prompts"] as const) {
			const src = join(envDir, sub);
			if (!existsSync(src)) continue;
			const entries = readdirSync(src, { withFileTypes: true });
			for (const e of entries) {
				const from = join(src, e.name);
				if (e.isSymbolicLink()) continue; // 池内共享资源由 links.json 记录
				cpSync(from, join(outDir, sub, e.name), { recursive: true });
			}
		}
		// 受管软链接清单
		const links: { path: string; target: string }[] = [];
		for (const sub of ["skills", "extensions", "themes"] as const) {
			const src = join(envDir, sub);
			if (!existsSync(src)) continue;
			for (const e of readdirSync(src, { withFileTypes: true })) {
				if (e.isSymbolicLink()) {
					links.push({ path: `${sub}/${e.name}`, target: readlinkSync(join(src, e.name)) });
				}
			}
		}
		writeAtomic(
			join(outDir, "ponda-export.json"),
			`${JSON.stringify({ name, exportedAt: new Date().toISOString(), links }, null, "\t")}\n`,
		);
	}

	importEnv(dir: string, opts: { name?: string } = {}): ResolvedEnv {
		const manifestFile = join(dir, "manifest.json");
		if (!existsSync(manifestFile)) throw new ValidationError(`导入目录缺少 manifest.json：${dir}`);
		const input = JSON.parse(readFileSync(manifestFile, "utf8")) as EnvManifestInput;
		const name = opts.name ?? input.name;
		if (name === undefined) throw new ValidationError("manifest 缺少 name 且未提供 --name");
		if (this.exists(name)) throw new ValidationError(`环境已存在：${name}`);
		const errors = validateManifestInput({ ...input, name });
		if (errors.length > 0) throw new ValidationError(errors.join("；"));

		const envDir = paths.env(this.home, name);
		mkdirSync(envDir, { recursive: true });
		for (const sub of ENV_SUBDIRS) mkdirSync(join(envDir, sub), { recursive: true });
		cpSync(manifestFile, join(envDir, "manifest.json"));
		for (const sub of ["skills", "extensions", "themes", "prompts"] as const) {
			const src = join(dir, sub);
			if (existsSync(src)) cpSync(src, join(envDir, sub), { recursive: true });
		}
		const res = this.resolve(name);
		renderEnv(this.home, name, res.effective);
		return res;
	}

	// —— doctor ——

	doctor(): { level: "error" | "warn" | "info"; message: string }[] {
		const report: { level: "error" | "warn" | "info"; message: string }[] = [];
		for (const name of this.names()) {
			try {
				const res = this.resolve(name);
				const plan = planRender(this.home, name, res.effective);
				for (const w of plan.warnings) report.push({ level: "warn", message: `${name}: ${w}` });
				// 渲染漂移：计划文件与磁盘内容比对
				const envDir = paths.env(this.home, name);
				for (const f of plan.files) {
					const abs = join(envDir, f.path);
					if (!existsSync(abs)) {
						report.push({ level: "error", message: `${name}: 缺少渲染产物 ${f.path}（重激活可修复）` });
					} else if (readFileSync(abs, "utf8") !== f.content) {
						report.push({ level: "warn", message: `${name}: ${f.path} 与 manifest 漂移（手改或旧版本渲染）` });
					}
				}
				for (const rel of plan.removed) {
					if (existsSync(join(envDir, rel))) {
						report.push({ level: "warn", message: `${name}: 存在应清理的产物 ${rel}` });
					}
				}
				// 断链检测
				for (const sub of ["skills", "extensions", "themes", "prompts"] as const) {
					const dir = join(envDir, sub);
					if (!existsSync(dir)) continue;
					for (const e of readdirSync(dir, { withFileTypes: true })) {
						if (!e.isSymbolicLink()) continue;
						try {
							const raw = readlinkRaw(join(dir, e.name));
							const resolved = join(dir, raw);
							if (!existsSync(resolved)) {
								report.push({ level: "warn", message: `${name}: 断链 ${sub}/${e.name} -> ${raw}` });
							}
						} catch {
							report.push({ level: "warn", message: `${name}: 无法读取链接 ${sub}/${e.name}` });
						}
					}
				}
			} catch (e) {
				report.push({ level: "error", message: `${name}: ${(e as Error).message}` });
			}
		}
		const state = this.readState();
		if (state.activeEnv && !this.exists(state.activeEnv)) {
			report.push({ level: "error", message: `state.json 指向不存在的环境：${state.activeEnv}` });
		}
		if (this.names().length === 0) {
			report.push({ level: "info", message: "尚无环境（ponda init 可创建 default 环境）" });
		}
		return report;
	}
}

// —— 局部工具 ——

function dirnameOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? "." : p.slice(0, i);
}

function writeAtomic(file: string, content: string): void {
	mkdirSync(dirnameOf(file), { recursive: true });
	const tmp = `${file}.ponda-tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, file);
}

function readlinkRaw(p: string): string {
	return readlinkSync(p);
}

function diffRecords(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
	prefix: string,
): { path: string; a?: unknown; b?: unknown }[] {
	const out: { path: string; a?: unknown; b?: unknown }[] = [];
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) {
		const path = prefix ? `${prefix}.${k}` : k;
		const va = a[k];
		const vb = b[k];
		if (va === undefined && vb === undefined) continue;
		if (
			typeof va === "object" &&
			va !== null &&
			!Array.isArray(va) &&
			typeof vb === "object" &&
			vb !== null &&
			!Array.isArray(vb)
		) {
			out.push(...diffRecords(va as Record<string, unknown>, vb as Record<string, unknown>, path));
			continue;
		}
		if (JSON.stringify(va) !== JSON.stringify(vb)) {
			out.push({ path, a: va, b: vb });
		}
	}
	return out;
}
