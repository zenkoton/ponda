import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeCommandTools, mergeEnv, mergeSelectors, unionPrivileges } from "../src/merge.ts";
import type { EnvManifestInput } from "../src/types.ts";

test("mergeSelectors：子覆盖父（原位）、新项追加、!name 排除", () => {
	const base = ["a", "b", "c"];
	const child = ["!b", { name: "a", version: "2" }, "d"];
	const merged = mergeSelectors(base, child as never);
	assert.deepEqual(
		merged.map((s) => (typeof s === "string" ? s : `${s.name}@${"version" in s ? s.version : s.path}`)),
		["a@2", "c", "d"],
	);
});

test("mergeEnv：标量覆盖 / appendSystemPrompt 拼接 / systemPrompt 整体覆盖", () => {
	const base: EnvManifestInput = {
		description: "base",
		identity: { systemPrompt: "base prompt", appendSystemPrompt: "base append" },
	};
	const child: EnvManifestInput = {
		identity: { systemPrompt: "child prompt", appendSystemPrompt: "child append" },
	};
	const m = mergeEnv(base, child);
	assert.equal(m.description, "base"); // 未声明继承
	assert.equal(m.identity?.systemPrompt, "child prompt");
	assert.equal(m.identity?.appendSystemPrompt, "base append\n\nchild append");
});

test("mergeEnv：tools.builtin 全量替换、custom 按 name 合并与删除", () => {
	const base: EnvManifestInput = {
		tools: {
			builtin: ["read", "bash", "edit", "write"],
			custom: [
				{ name: "deploy", description: "d", command: "old" },
				{ name: "lint", description: "l", command: "lint" },
			],
		},
	};
	const child: EnvManifestInput = {
		tools: {
			builtin: ["read", "edit"],
			custom: [
				{ name: "deploy", description: "d", command: "new" },
				{ name: "test", description: "t", command: "test" },
				{ name: "lint", delete: true },
			],
		},
	};
	const m = mergeEnv(base, child);
	assert.deepEqual(m.tools?.builtin, ["read", "edit"]); // 全量替换
	const customs = (m.tools?.custom ?? []) as { name: string; command: string }[];
	assert.deepEqual(
		customs.map((c) => c.name),
		["deploy", "test"],
	);
	assert.equal(customs[0].command, "new"); // 原位覆盖
});

test("mergeEnv：mcp 字典合并、null 删除", () => {
	const base: EnvManifestInput = { mcp: { a: { command: "a" }, b: { command: "b" } } };
	const child: EnvManifestInput = { mcp: { b: null, c: { url: "http://c" } } };
	const m = mergeEnv(base, child);
	assert.deepEqual(Object.keys(m.mcp ?? {}).sort(), ["a", "c"]);
});

test("mergeEnv：privileges 并集 + sandbox 深合并", () => {
	const base: EnvManifestInput = {
		privileges: {
			privileges: ["read", "write"],
			sandbox: { mode: "inplace", autoGitInit: true, outsideWorkspace: "temp-workspace" },
		},
	};
	const child: EnvManifestInput = {
		privileges: { privileges: ["execute"], sandbox: { mode: "worktree" } },
	};
	const m = mergeEnv(base, child);
	assert.deepEqual(m.privileges?.privileges, ["read", "write", "execute"]);
	assert.equal(m.privileges?.sandbox?.mode, "worktree");
	assert.equal(m.privileges?.sandbox?.autoGitInit, true); // 未声明继承
});

test("mergeEnv：keybindings null 删除", () => {
	const base: EnvManifestInput = { keybindings: { "ctrl.enter": "send", "ctrl.q": "quit" } };
	const child: EnvManifestInput = { keybindings: { "ctrl.q": null, "ctrl.x": "cut" } };
	const m = mergeEnv(base, child);
	assert.deepEqual(m.keybindings, { "ctrl.enter": "send", "ctrl.x": "cut" });
});

test("unionPrivileges 去重", () => {
	assert.deepEqual(unionPrivileges(["read"], ["read", "execute"]), ["read", "execute"]);
});

test("mergeCommandTools：父列表去重健壮性", () => {
	const merged = mergeCommandTools(
		[
			{ name: "a", description: "", command: "a" },
			{ name: "a", description: "", command: "a-dup" },
		],
		[{ name: "b", description: "", command: "b" }],
	);
	assert.deepEqual(
		merged.map((t) => t.name),
		["a", "b"],
	);
});
