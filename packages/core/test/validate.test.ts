import assert from "node:assert/strict";
import { test } from "node:test";
import { RESERVED_WORDS, validateEnvName, validateManifestInput } from "../src/validate.ts";

test("环境名规则：合法/非法/保留字", () => {
	assert.equal(validateEnvName("web-dev").length, 0);
	assert.equal(validateEnvName("a").length, 0);
	assert.notEqual(validateEnvName("Web").length, 0); // 大写
	assert.notEqual(validateEnvName("1abc").length, 0); // 数字开头
	assert.notEqual(validateEnvName("env").length, 0); // 保留字
	assert.ok(RESERVED_WORDS.includes("history"));
});

test("manifest 校验：sandbox/runtime 枚举", () => {
	const errors = validateManifestInput({
		privileges: { sandbox: { mode: "container" as never } },
		runtime: { permissionMode: "yolo" as never },
	});
	assert.ok(errors.length >= 2);
});

test("manifest 校验：合法差量通过", () => {
	const errors = validateManifestInput({
		schemaVersion: 1,
		name: "ok",
		base: "default",
		tools: {
			custom: [
				{ name: "deploy", command: "x", description: "y" },
				{ name: "old", delete: true },
			],
		},
		skills: ["react", { name: "vitest", version: "1.0.0" }],
		mcp: { browser: { command: "npx", args: ["-y", "@mcp/browser"] }, gone: null },
		models: {
			policy: "explicit",
			providers: {
				gl: {
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					apiKey: "$GL_KEY",
					models: [{ id: "m1" }],
				},
			},
		},
	});
	assert.deepEqual(errors, []);
});
