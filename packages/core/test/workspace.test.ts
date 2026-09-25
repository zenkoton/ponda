import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { findWorkspaceRoot, readWorkspaceConfig, resolveEnvForWorkspace } from "../src/workspace.ts";

const dirs: string[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-ws-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

test("findWorkspaceRoot：含 .ponda 的最近目录优先", () => {
	const root = newDir();
	const sub = join(root, "a", "b");
	mkdirSync(sub, { recursive: true });
	mkdirSync(join(root, ".ponda"), { recursive: true });
	assert.equal(findWorkspaceRoot(sub), root);
});

test("findWorkspaceRoot：回退到 .git 或 cwd", () => {
	const root = newDir();
	const sub = join(root, "x");
	mkdirSync(sub, { recursive: true });
	assert.equal(findWorkspaceRoot(sub), sub); // 无标记则 cwd 自身
	mkdirSync(join(root, ".git"), { recursive: true });
	assert.equal(findWorkspaceRoot(sub), root);
});

test("readWorkspaceConfig", () => {
	const root = newDir();
	mkdirSync(join(root, ".ponda"), { recursive: true });
	writeFileSync(join(root, ".ponda", "ponda.json"), JSON.stringify({ bind: "web-dev", pin: true }));
	const cfg = readWorkspaceConfig(root);
	assert.equal(cfg?.bind, "web-dev");
	assert.equal(readWorkspaceConfig(newDir()), null); // 无配置
});

test("resolveEnvForWorkspace 优先级：perWorkspace > bind > active > default", () => {
	const ws = newDir();
	mkdirSync(join(ws, ".ponda"), { recursive: true });
	writeFileSync(join(ws, ".ponda", "ponda.json"), JSON.stringify({ bind: "bind-env" }));

	let r = resolveEnvForWorkspace(ws, { activeEnv: "act" });
	assert.equal(r.env, "bind-env");
	assert.equal(r.source, "bind");
	assert.equal(r.conflict, true); // bind ≠ active

	r = resolveEnvForWorkspace(ws, { activeEnv: "act", perWorkspace: { [ws]: "local-env" } });
	assert.equal(r.env, "local-env");
	assert.equal(r.source, "perWorkspace");

	r = resolveEnvForWorkspace(newDir(), { activeEnv: "act" }); // 无绑定工作区
	assert.equal(r.env, "act");
	assert.equal(r.source, "active");

	r = resolveEnvForWorkspace(newDir(), { activeEnv: null });
	assert.equal(r.env, "default");
	assert.equal(r.source, "default");
});
