/**
 * 会话模型解析：daemon 启动时解析"本环境用哪个模型、如何取 key"（design: 02 §6.3）。
 * 优先级：PONDA_MODEL 环境变量 > 全局 ponda.json `.model`（内置目录 id）> 环境
 * models.json（ProviderDef，02 §6.1 渲染产物）首个 provider 的首个模型。
 * 全部未命中返回 null——daemon 回落演示回声循环并在首条回复提示配置方法。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getModel as getBuiltinModel, type Model } from "../../ai/src/compat.ts";
import { readProviderCredential, resolveCredentialLiteral } from "../../core/src/auth.ts";
import { paths } from "../../core/src/paths.ts";
import type { ProviderApi, ProviderDef } from "../../core/src/types.ts";

/** ponda ProviderApi → pi-ai Api 名（ProviderDef.api 是 ponda 侧简写） */
const API_MAP: Record<ProviderApi, string> = {
	"openai-completions": "openai-completions",
	"openai-responses": "openai-responses",
	anthropic: "anthropic-messages",
	"google-genai": "google-generative-ai",
};

export interface ResolvedModelConfig {
	model: Model<any>;
	modelId: string;
	/** ProviderDef.apiKey 解析（$ENV / !command / 明文）；内置目录模型返回 undefined（pi-ai 自动走环境变量） */
	getApiKey?: (provider: string) => string | undefined;
	source: "env-var" | "global-config" | "env-models";
}

export function resolveModelConfig(home: string, env: string): ResolvedModelConfig | null {
	const fromEnvVar = process.env.PONDA_MODEL;
	if (fromEnvVar !== undefined && fromEnvVar.length > 0) {
		const m = builtin(fromEnvVar);
		if (m !== null) return { model: m, modelId: fromEnvVar, source: "env-var" };
	}
	const fromGlobal = readGlobalModel(home);
	if (fromGlobal !== null) {
		const m = builtin(fromGlobal);
		if (m !== null) return { model: m, modelId: fromGlobal, source: "global-config" };
	}
	return fromEnvModels(home, env);
}

function builtin(id: string): Model<any> | null {
	const [provider, ...rest] = id.split("/");
	const modelId = rest.join("/") || id;
	const m = getBuiltinModel(provider as never, modelId as never);
	return (m ?? null) as Model<any> | null;
}

function readGlobalModel(home: string): string | null {
	try {
		const f = join(home, "ponda.json");
		if (!existsSync(f)) return null;
		const cfg = JSON.parse(readFileSync(f, "utf8")) as { model?: string };
		return typeof cfg.model === "string" && cfg.model.length > 0 ? cfg.model : null;
	} catch {
		return null;
	}
}

interface RenderedModelsJson {
	providers?: Record<string, ProviderDef>;
}

function fromEnvModels(home: string, env: string): ResolvedModelConfig | null {
	const f = join(paths.env(home, env), "models.json");
	if (!existsSync(f)) return null;
	let parsed: RenderedModelsJson;
	try {
		parsed = JSON.parse(readFileSync(f, "utf8")) as RenderedModelsJson;
	} catch {
		return null;
	}
	const providers = Object.entries(parsed.providers ?? {});
	const [providerName, def] = providers[0] ?? [];
	if (def === undefined || def.models.length === 0) return null;
	const m = def.models[0];
	if (m === undefined) return null;
	const api = API_MAP[def.api] ?? def.api;
	const modelId = `${providerName}/${m.id}`;
	const model: Model<any> = {
		id: m.id,
		name: m.id,
		api: api as never,
		provider: providerName,
		baseUrl: def.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: m.thinking === true,
		contextWindow: m.contextWindow ?? 128000,
		maxTokens: 8192,
	};
	return {
		model,
		modelId,
		source: "env-models",
		getApiKey: (provider: string): string | undefined => {
			if (provider !== providerName) return undefined;
			// 凭据优先级：auth.json 明文（0600，02 §6.1） > models.json 引用（$ENV/!command）
			// > 旧渲染产物的明文（兼容迁移前环境）
			return (
				readProviderCredential(home, env, providerName) ??
				(def.apiKey !== undefined ? resolveCredentialLiteral(def.apiKey) : undefined)
			);
		},
	};
}
