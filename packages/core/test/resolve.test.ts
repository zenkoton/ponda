import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvCycleError, EnvNotFoundError, materialize, resolveEnv } from "../src/resolve.ts";
import type { EnvManifestInput } from "../src/types.ts";

function reader(map: Record<string, EnvManifestInput>) {
	return (name: string): EnvManifestInput | null => map[name] ?? null;
}

test("resolveEnv：目标环境不存在 → not found（仅 default 特殊回落）", () => {
	assert.throws(() => resolveEnv(reader({}), "web"), EnvNotFoundError);
	const res = resolveEnv(reader({}), "default");
	assert.deepEqual(res.chain, []);
	assert.equal(res.effective.identity.systemPrompt, "You are a helpful coding agent.");
});

test("resolveEnv：default 不存在但目标存在 → base 回落 defaults", () => {
	const res = resolveEnv(reader({ web: { name: "web" } }), "web");
	assert.deepEqual(res.chain, ["web"]);
	assert.equal(res.effective.runtime.permissionMode, "approve"); // 默认层
});

test("resolveEnv：多层继承合并", () => {
	const res = resolveEnv(
		reader({
			default: { name: "default", identity: { systemPrompt: "base" }, skills: ["common"] },
			web: {
				name: "web",
				base: "default",
				identity: { appendSystemPrompt: "web rules" },
				skills: ["react", "!common"],
			},
			web2: { name: "web2", base: "web", identity: { appendSystemPrompt: "more" } },
		}),
		"web2",
	);
	assert.deepEqual(res.chain, ["web2", "web", "default"]);
	assert.equal(res.effective.identity.systemPrompt, "base");
	assert.equal(res.effective.identity.appendSystemPrompt, "web rules\n\nmore");
	assert.deepEqual(res.effective.skills, ["react"]);
});

test("resolveEnv：成环检测", () => {
	assert.throws(
		() =>
			resolveEnv(
				reader({
					a: { name: "a", base: "b" },
					b: { name: "b", base: "a" },
				}),
				"a",
			),
		EnvCycleError,
	);
});

test("resolveEnv：中间环境缺失", () => {
	assert.throws(() => resolveEnv(reader({ a: { name: "a", base: "ghost" } }), "a"), EnvNotFoundError);
});

test("materialize：差量补全为完整形态且幂等", () => {
	const m1 = materialize({ runtime: { maxParallelSubagents: 5 } }, { name: "x", createdAt: "t1", updatedAt: "t2" });
	assert.equal(m1.runtime.maxParallelSubagents, 5);
	assert.deepEqual(m1.tools.builtin, ["read", "bash", "edit", "write"]);
	assert.equal(m1.models.policy, "inherit-global");
	const m2 = materialize(JSON.parse(JSON.stringify(m1)), { name: "x", createdAt: "t1", updatedAt: "t2" });
	assert.deepEqual(m1, m2);
});
