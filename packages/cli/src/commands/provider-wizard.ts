/** provider 交互式向导（design: 02-resources.md §6.2；M2 收尾） */
import * as readline from "node:readline";
import { isCredentialReference, resolveCredentialLiteral } from "../../../core/src/auth.ts";
import type { ProviderDef } from "../../../core/src/types.ts";

const APIS = [
	{ id: "openai-completions", label: "OpenAI 兼容（大多数国产/开源模型）", defaultUrl: "https://api.openai.com/v1" },
	{ id: "openai-responses", label: "OpenAI Responses API", defaultUrl: "https://api.openai.com/v1" },
	{ id: "anthropic", label: "Anthropic（Claude 系列）", defaultUrl: "https://api.anthropic.com" },
	{
		id: "google-genai",
		label: "Google GenAI（Gemini 系列）",
		defaultUrl: "https://generativelanguage.googleapis.com/v1beta",
	},
] as const;

export interface WizardResult {
	providerName: string;
	def: ProviderDef;
	saveToPool: boolean;
	/** 用户直接粘贴的明文凭据：不进 def/manifest/池，由调用方存环境 auth.json（0600） */
	plainApiKey?: string;
}

/** 交互式六步向导（TTY 可用时自动触发；非 TTY 回退旗标模式） */
export async function runProviderWizard(): Promise<WizardResult | null> {
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		return null;
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q: string): Promise<string> =>
		new Promise((resolve) => {
			rl.question(q, (a) => resolve(a.trim()));
		});
	const askDefault = async (q: string, def: string): Promise<string> => {
		const a = await ask(`${q} [${def}]: `);
		return a.length > 0 ? a : def;
	};

	try {
		console.log("\n── ponda provider 交互式配置（design: 02 §6.2）──\n");

		// 1. 名称
		const providerName = await askDefault("Provider 名称", "my-provider");
		if (providerName.length === 0) return null;

		// 2. API 类型
		console.log("\n选择 API 类型：");
		for (let i = 0; i < APIS.length; i++) {
			const a = APIS[i] as (typeof APIS)[number];
			console.log(`  ${i + 1}. ${a.label} (${a.id})`);
		}
		const apiIdx = Number.parseInt(await askDefault("序号", "1"), 10) - 1;
		const selected = APIS[Math.max(0, Math.min(APIS.length - 1, apiIdx))] ?? (APIS[0] as (typeof APIS)[number]);

		// 3. baseUrl
		const baseUrl = await askDefault(`\nBase URL`, selected.defaultUrl);

		// 4. 凭据（推荐 $ENV / !command 避免明文落盘）
		console.log("\n凭据（推荐 $ENV_VAR 或 !command，避免明文落盘）：");
		console.log("  直接粘贴按 Enter 后输入");
		console.log("  环境变量输入如 $MY_API_KEY");
		console.log("  命令获取输入如 !pass show api-key");
		const apiKey = await ask("API Key: ");
		if (apiKey.length === 0) {
			console.log("未提供凭据，跳过（可稍后经 ponda auth 配置）");
		}

		// 5. 模型发现（尝试调 /models；失败手输）
		const models: { id: string; thinking?: boolean; contextWindow?: number }[] = [];
		console.log("\n模型发现（尝试 GET /models）...");
		const discovered = await discoverModels(baseUrl, apiKey);
		if (discovered.length > 0) {
			console.log(`发现 ${discovered.length} 个模型：`);
			for (let i = 0; i < Math.min(discovered.length, 20); i++) {
				console.log(`  ${i + 1}. ${discovered[i]}`);
			}
			console.log("输入要纳入的序号（逗号分隔，a=全部，n=手输）：");
			const sel = await askDefault("选择", "a");
			if (sel === "a") {
				for (const id of discovered.slice(0, 50)) models.push({ id });
			} else if (sel !== "n") {
				for (const idx of sel
					.split(/[,\s]+/)
					.filter(Boolean)
					.map(Number)) {
					const id = discovered[idx - 1];
					if (id !== undefined) models.push({ id });
				}
			}
		}
		if (models.length === 0) {
			console.log("手输模型 id（每行一个，空行结束）：");
			for (;;) {
				const id = await ask("  model id: ");
				if (id.length === 0) break;
				models.push({ id });
			}
		}
		if (models.length === 0) {
			models.push({ id: "default" });
			console.log("（未指定，使用 default）");
		}

		// 6. 写入目标
		console.log("\n写入目标：");
		console.log("  1. 仅当前环境");
		console.log("  2. 存入池供共享（推荐，多环境可复用）");
		const target = await askDefault("选择", "2");
		const saveToPool = target !== "1";

		// 凭据分离（02 §6.1）：引用形式（$ENV/!command）入 def；明文单独返回（→ auth.json 0600）
		const def: ProviderDef = {
			baseUrl,
			api: selected.id,
			...(apiKey.length > 0 && isCredentialReference(apiKey) ? { apiKey } : {}),
			models,
		};
		const plainApiKey = apiKey.length > 0 && !isCredentialReference(apiKey) ? apiKey : undefined;

		return { providerName, def, saveToPool, plainApiKey };
	} finally {
		rl.close();
	}
}

/** 尝试 GET <baseUrl>/models 发现模型列表 */
async function discoverModels(baseUrl: string, apiKey: string): Promise<string[]> {
	try {
		const url = `${baseUrl.replace(/\/$/, "")}/models`;
		const headers: Record<string, string> = { Accept: "application/json" };
		// $ENV / !command / 明文均可用于发现请求（引用经 resolveCredentialLiteral 解析）
		const resolved = apiKey.length > 0 ? resolveCredentialLiteral(apiKey) : undefined;
		if (resolved !== undefined) headers.Authorization = `Bearer ${resolved}`;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 5000);
		const res = await fetch(url, { headers, signal: ctrl.signal });
		clearTimeout(timer);
		if (!res.ok) return [];
		const json = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string }[] };
		const list = json.data ?? json.models ?? [];
		return list
			.map((m) => m.id ?? "")
			.filter((id) => id.length > 0)
			.slice(0, 50);
	} catch {
		return [];
	}
}
