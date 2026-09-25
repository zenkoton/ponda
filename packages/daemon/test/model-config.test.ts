/**
 * 会话模型解析（model-config）：三级模型来源与凭据优先级
 * （auth.json 明文 > models.json 引用 $ENV/!command > 旧渲染明文兼容）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { saveProviderCredential } from "../../core/src/auth.ts";
import { paths } from "../../core/src/paths.ts";
import { resolveModelConfig } from "../src/model-config.ts";

const cleanups: (() => void)[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-mc-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	delete process.env.PONDA_MODEL;
	delete process.env.PONDA_TEST_MC_KEY;
});

function writeModelsJson(home: string, env: string, providers: Record<string, unknown>): void {
	const dir = paths.env(home, env);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }, null, "\t"));
}

test("env models.json：引用形式 $ENV 解析", () => {
	const home = newHome();
	process.env.PONDA_TEST_MC_KEY = "ref-value";
	writeModelsJson(home, "web", {
		p: { baseUrl: "https://a", api: "openai-completions", apiKey: "$PONDA_TEST_MC_KEY", models: [{ id: "m1" }] },
	});
	const cfg = resolveModelConfig(home, "web");
	assert.ok(cfg !== null);
	assert.equal(cfg.source, "env-models");
	assert.equal(cfg.modelId, "p/m1");
	assert.equal(cfg.getApiKey?.("p"), "ref-value");
	assert.equal(cfg.getApiKey?.("other"), undefined, "其他 provider 不给 key");
});

test("凭据优先级：auth.json 明文 > models.json 引用", () => {
	const home = newHome();
	process.env.PONDA_TEST_MC_KEY = "ref-value";
	writeModelsJson(home, "web", {
		p: { baseUrl: "https://a", api: "openai-completions", apiKey: "$PONDA_TEST_MC_KEY", models: [{ id: "m1" }] },
	});
	saveProviderCredential(home, "web", "p", "auth-file-value");
	const cfg = resolveModelConfig(home, "web");
	assert.equal(cfg?.getApiKey?.("p"), "auth-file-value", "auth.json 优先");
});

test("兼容：旧渲染产物的明文 apiKey 仍可用（迁移前环境）", () => {
	const home = newHome();
	writeModelsJson(home, "web", {
		p: { baseUrl: "https://a", api: "openai-completions", apiKey: "legacy-plain", models: [{ id: "m1" }] },
	});
	const cfg = resolveModelConfig(home, "web");
	assert.equal(cfg?.getApiKey?.("p"), "legacy-plain");
});

test("PONDA_MODEL 环境变量优先且命中内置目录", () => {
	const home = newHome();
	writeModelsJson(home, "web", {
		p: { baseUrl: "https://a", api: "openai-completions", apiKey: "x", models: [{ id: "m1" }] },
	});
	process.env.PONDA_MODEL = "anthropic/claude-sonnet-4-5";
	const cfg = resolveModelConfig(home, "web");
	assert.ok(cfg !== null);
	assert.equal(cfg.source, "env-var");
	assert.equal(cfg.modelId, "anthropic/claude-sonnet-4-5");
	assert.equal(cfg.getApiKey, undefined, "内置目录模型走 pi-ai env-key 路径");
});

test("无任何配置返回 null（daemon 回落演示回声模式）", () => {
	const home = newHome();
	assert.equal(resolveModelConfig(home, "web"), null);
});
