/**
 * 凭据隔离（design: 02 §6.1 / 00 §8）：明文 apiKey 只落 env/<name>/auth.json（0600）；
 * manifest/渲染产物 models.json/资源池 只允许引用形式（$ENV / !command）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	isCredentialReference,
	mergeProviderCredentials,
	readEnvAuth,
	readProviderCredential,
	resolveCredentialLiteral,
	saveProviderCredential,
} from "../src/auth.ts";
import { planRender } from "../src/render.ts";
import { ResourceStore } from "../src/resources.ts";
import { EnvStore } from "../src/store.ts";
import type { EnvManifest } from "../src/types.ts";

const cleanups: (() => void)[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-auth-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function manifestWithProviders(providers: Record<string, unknown>): EnvManifest {
	return {
		schemaVersion: 1,
		name: "web",
		identity: { systemPrompt: "x", memory: {} },
		tools: { builtin: ["read"], custom: [] },
		skills: [],
		extensions: [],
		themes: [],
		mcp: {},
		models: { policy: "explicit", providers: providers as never },
		privileges: { privileges: ["read"], sandbox: { mode: "inplace", autoGitInit: true, outsideWorkspace: "deny" } },
		runtime: {
			backgroundLiveness: true,
			contextStrategy: "pi-compaction",
			maxParallelSubagents: 3,
			permissionMode: "approve",
		},
		createdAt: "2026-09-25T00:00:00Z",
		updatedAt: "2026-09-25T00:00:00Z",
	};
}

test("planRender：明文 apiKey 剥离进 credentials，引用形式保留在 models.json", () => {
	const home = newHome();
	const plan = planRender(
		home,
		"web",
		manifestWithProviders({
			plain: { baseUrl: "https://a", api: "openai-completions", apiKey: "sk-secret", models: [{ id: "m1" }] },
			ref: { baseUrl: "https://b", api: "anthropic", apiKey: "$MY_KEY", models: [{ id: "m2" }] },
			cmd: { baseUrl: "https://c", api: "anthropic", apiKey: "!pass show k", models: [{ id: "m3" }] },
		}),
	);
	const modelsFile = plan.files.find((f) => f.path === "models.json");
	assert.ok(modelsFile !== undefined);
	const parsed = JSON.parse(modelsFile.content) as {
		providers: Record<string, { apiKey?: string }>;
	};
	assert.equal(parsed.providers.plain?.apiKey, undefined, "明文不进 models.json");
	assert.equal(parsed.providers.ref?.apiKey, "$MY_KEY", "引用形式保留");
	assert.equal(parsed.providers.cmd?.apiKey, "!pass show k", "!command 保留");
	assert.deepEqual(plan.credentials, { plain: "sk-secret" }, "明文进 credentials 计划");
});

test("saveProviderCredential：写 auth.json 权限 0600，合并保留其他条目，幂等", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "web" });
	saveProviderCredential(home, "web", "p1", "k1");
	const file = join(home, "envs", "web", "auth.json");
	assert.ok(existsSync(file));
	assert.equal(statSync(file).mode & 0o777, 0o600, "权限 0600");
	assert.equal(readProviderCredential(home, "web", "p1"), "k1");
	// 合并：另一个 provider 不覆盖
	saveProviderCredential(home, "web", "p2", "k2");
	assert.equal(readProviderCredential(home, "web", "p1"), "k1");
	assert.equal(readProviderCredential(home, "web", "p2"), "k2");
	// 幂等：同值重写不报错
	saveProviderCredential(home, "web", "p2", "k2");
	assert.equal(readProviderCredential(home, "web", "p2"), "k2");
	// 未知字段保留
	const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	raw.custom = { keep: true };
	writeFileSync(file, JSON.stringify(raw));
	mergeProviderCredentials(home, "web", { p3: "k3" });
	const after = readEnvAuth(home, "web") as unknown as Record<string, unknown>;
	assert.ok(after.custom !== undefined, "未知字段保留");
});

test("installProviderDef：池剥离明文、保留引用", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	const res = new ResourceStore(home, store);
	res.installProviderDef("plain", {
		baseUrl: "https://a",
		api: "openai-completions",
		apiKey: "sk-plain",
		models: [{ id: "m" }],
	});
	res.installProviderDef("ref", {
		baseUrl: "https://b",
		api: "anthropic",
		apiKey: "$MY_KEY",
		models: [{ id: "m" }],
	});
	const plain = res.readProviderDef("plain");
	const ref = res.readProviderDef("ref");
	assert.equal(plain?.apiKey, undefined, "池内无明文");
	assert.equal(ref?.apiKey, "$MY_KEY", "池内保留引用");
});

test("doctor：manifest 明文 apiKey 自动迁移（auth.json + 声明层剥离 + models.json 干净）", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.create({
		name: "web",
		base: "default",
		systemPrompt: "x",
	});
	// 直接给 web 的 manifest 塞一个明文 provider（模拟旧版本产物）
	const m = store.readManifest("web");
	assert.ok(m !== null);
	m.models = {
		policy: "explicit",
		providers: {
			old: { baseUrl: "https://a", api: "openai-completions", apiKey: "sk-legacy", models: [{ id: "m" }] },
		},
	};
	store.saveManifest(m);
	store.rerender("web");

	const report = store.doctor();
	assert.ok(
		report.some((r) => r.message.includes("已迁移到 envs/web/auth.json")),
		`迁移报告：${report.map((r) => r.message).join(" | ")}`,
	);
	assert.equal(readProviderCredential(home, "web", "old"), "sk-legacy");
	const manifest = store.readManifest("web");
	assert.equal(
		(manifest?.models?.providers?.old as { apiKey?: string } | undefined)?.apiKey,
		undefined,
		"声明层 manifest 已剥离",
	);
	const modelsJson = JSON.parse(readFileSync(join(home, "envs", "web", "models.json"), "utf8")) as {
		providers: Record<string, { apiKey?: string }>;
	};
	assert.equal(modelsJson.providers.old?.apiKey, undefined, "渲染产物无明文");
	// 幂等：再跑 doctor 无迁移报告
	const report2 = store.doctor();
	assert.ok(!report2.some((r) => r.message.includes("已迁移")), "迁移幂等");
});

test("resolveCredentialLiteral：$ENV / !command / 明文三形式", () => {
	process.env.PONDA_TEST_KEY = "env-value";
	assert.equal(resolveCredentialLiteral("$PONDA_TEST_KEY"), "env-value");
	assert.equal(resolveCredentialLiteral("$PONDA_MISSING_KEY_XYZ"), undefined);
	assert.equal(resolveCredentialLiteral("!echo cmd-value"), "cmd-value");
	assert.equal(resolveCredentialLiteral("plain-value"), "plain-value");
	assert.equal(resolveCredentialLiteral(""), undefined);
	assert.ok(isCredentialReference("$A"));
	assert.ok(isCredentialReference("!echo x"));
	assert.ok(!isCredentialReference("plain"));
});
