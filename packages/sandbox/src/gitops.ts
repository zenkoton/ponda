/**
 * git 快照引擎（design: 03 §5.1/§5.2）：
 * - ensureGit：工作区无 .git 时按策略自动初始化（含全量初始 commit）
 * - snapshot：临时索引 write-tree → commit-tree → update-ref，不切换分支、不动真实索引，
 *   捕获含未跟踪文件在内的全部变更
 * - rollback：恢复工作区到某快照
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}): GitResult {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
	return {
		ok: r.status === 0,
		stdout: (r.stdout ?? "").trim(),
		stderr: (r.stderr ?? "").trim(),
		code: r.status ?? -1,
	};
}

export function isGitRepo(workspace: string): boolean {
	const r = git(workspace, ["rev-parse", "--is-inside-work-tree"]);
	return r.ok && r.stdout === "true";
}

export interface EnsureGitResult {
	repo: true;
	initialized: boolean; // 本次调用新建的仓库
}

/** 无 .git 时按 autoGitInit 策略初始化（含 .ponda/.wiki 忽略与初始提交）；拒绝时返回 null */
export function ensureGit(workspace: string, opts: { autoGitInit: boolean }): EnsureGitResult | null {
	if (isGitRepo(workspace)) return { repo: true, initialized: false };
	if (!opts.autoGitInit) return null;
	git(workspace, ["init", "-q"]);
	// ponda 运行数据不入库
	const ignoreFile = join(workspace, ".gitignore");
	if (!existsSync(ignoreFile)) {
		writeFileSync(ignoreFile, ".ponda/\n.wiki/\n", "utf8");
	}
	git(workspace, ["add", "-A"]);
	git(workspace, [
		"-c",
		"user.name=ponda",
		"-c",
		"user.email=ponda@local",
		"commit",
		"-q",
		"-m",
		"ponda: initial snapshot",
	]);
	return { repo: true, initialized: true };
}

export function snapshotBranchName(sessionId: string): string {
	return `ponda/snapshots/${sessionId}`;
}

/**
 * 快照当前工作区状态到快照分支（不动真实索引/分支）。
 * 实现：GIT_INDEX_FILE 指向临时索引 → add -A → write-tree → commit-tree(父=HEAD) → update-ref。
 */
export function snapshot(
	workspace: string,
	sessionId: string,
	label: string,
): { ok: boolean; ref?: string; commit?: string; detail: string } {
	if (!isGitRepo(workspace)) return { ok: false, detail: "not a git repo" };
	const branch = snapshotBranchName(sessionId);
	const tmpIndex = join(workspace, ".git", "ponda-snap-index");
	try {
		const idxEnv = { GIT_INDEX_FILE: tmpIndex };
		const head = git(workspace, ["rev-parse", "HEAD"]);
		const add = git(workspace, ["add", "-A"], idxEnv);
		if (!add.ok) return { ok: false, detail: add.stderr };
		const tree = git(workspace, ["write-tree"], idxEnv);
		if (!tree.ok) return { ok: false, detail: tree.stderr };
		// 父链：第一父=上一快照（审计链，snapshotLog 走 --first-parent），第二父=HEAD（血缘）
		const prev = git(workspace, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]);
		const parentArgs: string[] = [];
		if (prev.ok) parentArgs.push("-p", prev.stdout);
		if (head.ok) parentArgs.push("-p", head.stdout);
		const commit = git(workspace, ["commit-tree", tree.stdout, ...parentArgs, "-m", `ponda: ${label}`]);
		if (!commit.ok) return { ok: false, detail: commit.stderr };
		const upd = git(workspace, ["update-ref", `refs/heads/${branch}`, commit.stdout]);
		if (!upd.ok) return { ok: false, detail: upd.stderr };
		return { ok: true, ref: branch, commit: commit.stdout, detail: label };
	} finally {
		try {
			if (existsSync(tmpIndex)) rmSync(tmpIndex);
		} catch {}
	}
}

/** 快照分支上的提交列表（新→旧；沿第一父走快照审计链，不含 HEAD 血缘历史） */
export function snapshotLog(workspace: string, sessionId: string, limit = 50): { commit: string; message: string }[] {
	const branch = snapshotBranchName(sessionId);
	const r = git(workspace, ["log", "--first-parent", "--format=%H%x09%s", "-n", String(limit), branch]);
	if (!r.ok) return [];
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [commit, ...rest] = line.split("\t");
			return { commit, message: rest.join("\t") };
		})
		.filter((e) => e.message.startsWith("ponda:")); // 只保留快照提交（链尾是 HEAD 血缘）
}

/** 回滚工作区到指定快照（reset --hard；执行前调用方应确认用户已批准） */
export function rollback(workspace: string, _sessionId: string, commit: string): { ok: boolean; detail: string } {
	const r = git(workspace, ["reset", "--hard", commit]);
	return r.ok ? { ok: true, detail: commit } : { ok: false, detail: r.stderr };
}

/** diff 摘要：两个引用间变更文件（name-status） */
export function diffSummary(workspace: string, from: string, to: string): { status: string; path: string }[] {
	const r = git(workspace, ["diff", "--name-status", from, to]);
	if (!r.ok) return [];
	return r.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, ...rest] = line.split("\t");
			return { status, path: rest.join("\t") };
		});
}

/** worktree 管理（design: 03 §5.3） */
export function addWorktree(
	workspace: string,
	wtId: string,
): { ok: boolean; dir?: string; branch?: string; detail: string } {
	const branch = `ponda/wt/${wtId}`;
	const dir = join(workspace, ".ponda", "worktrees", wtId);
	const r = git(workspace, ["worktree", "add", "-b", branch, dir]);
	return r.ok ? { ok: true, dir, branch, detail: r.stdout } : { ok: false, detail: r.stderr };
}

export function removeWorktree(workspace: string, wtId: string): { ok: boolean; detail: string } {
	const dir = join(workspace, ".ponda", "worktrees", wtId);
	const r = git(workspace, ["worktree", "remove", "--force", dir]);
	return r.ok ? { ok: true, detail: r.stdout } : { ok: false, detail: r.stderr };
}
