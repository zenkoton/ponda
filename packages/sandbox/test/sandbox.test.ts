import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	addWorktree,
	diffSummary,
	ensureGit,
	removeWorktree,
	rollback,
	snapshot,
	snapshotBranchName,
	snapshotLog,
} from "../src/gitops.ts";
import { createSandbox, listSandboxes, mapPath, settleSandbox } from "../src/tempws.ts";

const dirs: string[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-git-"));
	dirs.push(d);
	return d;
}
function newHome(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-home-"));
	dirs.push(d);
	return d;
}
function sh(cwd: string, gitArgs: string): string {
	const args = gitArgs.replace(/^git\s+/, "").split(/\s+/);
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

test("ensureGit：自动初始化 + 初始提交 + 忽略 .ponda", () => {
	const ws = newDir();
	mkdirSync(join(ws, "src"), { recursive: true });
	writeFileSync(join(ws, "src", "a.ts"), "a");
	const r = ensureGit(ws, { autoGitInit: true });
	assert.equal(r?.initialized, true);
	assert.ok(sh(ws, "log --oneline -1").includes("ponda: initial snapshot"));
	// 已有仓库 → initialized false
	assert.equal(ensureGit(ws, { autoGitInit: true })?.initialized, false);
	// 无 autoGitInit → null
	const other = newDir();
	assert.equal(ensureGit(other, { autoGitInit: false }), null);
});

test("snapshot：捕获修改与未跟踪文件、形成审计链、不动 HEAD 与真实索引", () => {
	const ws = newDir();
	writeFileSync(join(ws, "base"), "v0");
	sh(ws, "git init -q");
	sh(ws, "git add -A");
	sh(ws, "git -c user.name=t -c user.email=t@t commit -qm init");
	const headBefore = sh(ws, "git rev-parse HEAD");

	writeFileSync(join(ws, "base"), "v1"); // 修改
	writeFileSync(join(ws, "untracked"), "new"); // 未跟踪

	const s1 = snapshot(ws, "sess-1", "turn 1");
	assert.equal(s1.ok, true, s1.detail);
	assert.equal(sh(ws, "git rev-parse HEAD"), headBefore, "HEAD 不变");
	assert.equal(existsSync(join(ws, ".git", "ponda-snap-index")), false, "临时索引已清理");

	const branch = snapshotBranchName("sess-1");
	assert.ok(sh(ws, `git show ${branch}:untracked`).startsWith("new"), "快照含未跟踪文件");
	assert.ok(sh(ws, `git show ${branch}:base`).startsWith("v1"));

	// 第二个快照 → 审计链（父=前一快照）
	writeFileSync(join(ws, "base"), "v2");
	const s2 = snapshot(ws, "sess-1", "turn 2");
	assert.equal(s2.ok, true);
	const log = snapshotLog(ws, "sess-1");
	assert.equal(log.length, 2);
	assert.ok(log[0].message.includes("turn 2"));

	// diff 摘要
	const d = diffSummary(ws, headBefore, s2.commit as string);
	assert.ok(d.some((x) => x.path === "base" && x.status === "M"));
	assert.ok(d.some((x) => x.path === "untracked" && x.status === "A"));

	// 回滚到 turn 1
	const rb = rollback(ws, "sess-1", s1.commit as string);
	assert.equal(rb.ok, true);
	assert.equal(readFileSync(join(ws, "base"), "utf8"), "v1");
});

test("worktree：add/remove", () => {
	const ws = newDir();
	writeFileSync(join(ws, "a"), "a");
	sh(ws, "git init -q");
	sh(ws, "git add -A");
	sh(ws, "git -c user.name=t -c user.email=t@t commit -qm init");

	const wt = addWorktree(ws, "wt-1");
	assert.equal(wt.ok, true, wt.detail);
	assert.ok(existsSync(join(wt.dir as string, "a")), "worktree 含工作区文件");

	const rm = removeWorktree(ws, "wt-1");
	assert.equal(rm.ok, true, rm.detail);
});

test("临时工作区：创建拷贝 → 修改 → apply 写回带备份；discard 不动原文件", () => {
	const home = newHome();
	const outside = newDir();
	writeFileSync(join(outside, "conf.yaml"), "original: 1");

	const sb = createSandbox("sess-abcd1234", 1, [join(outside, "conf.yaml")], home);
	assert.equal(listSandboxes(home).length, 1);
	// agent 修改沙箱副本
	writeFileSync(sb.mappings[join(outside, "conf.yaml")], "original: 2", "utf8");

	// mapPath 查询
	assert.equal(mapPath(sb, join(outside, "conf.yaml")), sb.mappings[join(outside, "conf.yaml")]);

	const result = settleSandbox(sb, "apply", { home });
	assert.equal(result.outcome, "apply");
	assert.equal(result.files[0].changed, true);
	assert.equal(result.files[0].applied, true);
	assert.equal(readFileSync(join(outside, "conf.yaml"), "utf8"), "original: 2");
	assert.equal(result.backups.length, 1, "原文件已备份");
	assert.ok(existsSync(result.backups[0]));
	assert.equal(readFileSync(result.backups[0], "utf8"), "original: 1", "备份保留原内容");
	assert.equal(listSandboxes(home).length, 0, "结算后沙箱归档");

	// discard 路径
	const outside2 = newDir();
	writeFileSync(join(outside2, "f2"), "keep");
	const sb2 = createSandbox("sess-abcd1234", 2, [join(outside2, "f2")], home);
	writeFileSync(sb2.mappings[join(outside2, "f2")], "changed", "utf8");
	const r2 = settleSandbox(sb2, "discard", { home });
	assert.equal(r2.outcome, "discard");
	assert.equal(readFileSync(join(outside2, "f2"), "utf8"), "keep", "原文件不动");
	assert.equal(r2.backups.length, 0);
});

test("临时工作区：新建文件（原路径不存在）apply 时创建", () => {
	const home = newHome();
	const outside = newDir();
	const sb = createSandbox("sess-efgh5678", 1, [join(outside, "new-dir", "brand-new.txt")], home);
	writeFileSync(sb.mappings[join(outside, "new-dir", "brand-new.txt")], "created", "utf8");
	const r = settleSandbox(sb, "apply", { home });
	assert.equal(r.files[0].created, true);
	assert.equal(readFileSync(join(outside, "new-dir", "brand-new.txt"), "utf8"), "created");
});
