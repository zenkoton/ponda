/**
 * 环境凭据存储（design: 00 §8 / 02 §6.1）：明文 apiKey 只落 `env/<name>/auth.json`
 * （权限 0600，ponda 托管写入）；manifest 与渲染产物 models.json 只允许引用形式
 * （`$ENV_VAR` / `!command`，pi 原生解析）。
 */
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths } from "./paths.ts";

export interface EnvAuthFile {
	/** provider 名 → 明文凭据（绝不进入 manifest/models.json） */
	providers: Record<string, { apiKey: string }>;
	/** 保留未知字段（用户手工条目等） */
	[key: string]: unknown;
}

const AUTH_MODE = 0o600;

export function authFilePath(home: string, env: string): string {
	return join(paths.env(home, env), "auth.json");
}

export function readEnvAuth(home: string, env: string): EnvAuthFile {
	const f = authFilePath(home, env);
	if (!existsSync(f)) return { providers: {} };
	try {
		const parsed = JSON.parse(readFileSync(f, "utf8")) as EnvAuthFile;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.providers !== "object") {
			return { providers: {} };
		}
		return parsed;
	} catch {
		return { providers: {} };
	}
}

function writeEnvAuthFile(path: string, auth: EnvAuthFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.ponda-tmp`;
	writeFileSync(tmp, `${JSON.stringify(auth, null, "\t")}\n`, { encoding: "utf8", mode: AUTH_MODE });
	chmodSync(tmp, AUTH_MODE); // 写入 mode 只在创建时生效，显式兜底
	renameSync(tmp, path);
}

/** 合并写入某 provider 的明文凭据（保留其他条目；幂等） */
export function saveProviderCredential(home: string, env: string, provider: string, apiKey: string): void {
	const auth = readEnvAuth(home, env);
	if (auth.providers[provider]?.apiKey === apiKey) return;
	auth.providers[provider] = { apiKey };
	writeEnvAuthFile(authFilePath(home, env), auth);
}

export function readProviderCredential(home: string, env: string, provider: string): string | undefined {
	const key = readEnvAuth(home, env).providers[provider]?.apiKey;
	return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** 渲染侧批量合并（applyRender 用；仅当内容变化才写盘） */
export function mergeProviderCredentials(home: string, env: string, credentials: Record<string, string>): boolean {
	if (Object.keys(credentials).length === 0) return false;
	const auth = readEnvAuth(home, env);
	let changed = false;
	for (const [provider, key] of Object.entries(credentials)) {
		if (auth.providers[provider]?.apiKey !== key) {
			auth.providers[provider] = { apiKey: key };
			changed = true;
		}
	}
	if (changed) writeEnvAuthFile(authFilePath(home, env), auth);
	return changed;
}

/** 引用形式（$ENV / !command）：可安全留在 manifest/models.json，pi 原生解析 */
export function isCredentialReference(literal: string): boolean {
	return literal.startsWith("$") || literal.startsWith("!");
}

/**
 * 解析凭据字面量：$ENV_VAR → 环境变量；!command → 执行取 stdout；明文原样返回。
 * 解析失败返回 undefined（调用方回退默认 key 路径）。
 */
export function resolveCredentialLiteral(literal: string): string | undefined {
	if (literal.startsWith("$")) {
		const v = process.env[literal.slice(1)];
		return v !== undefined && v.length > 0 ? v : undefined;
	}
	if (literal.startsWith("!")) {
		try {
			const out = execSync(literal.slice(1), { encoding: "utf8", timeout: 10000 }).trim();
			return out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	}
	return literal.length > 0 ? literal : undefined;
}
