/**
 * 模式 A inplace 沙箱活动（design: 03 §5.2/§6）：
 * - turn_end 快照链：每轮结束 git 有变更则向 ponda/snapshots/<sessionShortId>
 *   提交 `ponda: auto: turn <n>`（不动真实索引/分支，含未跟踪文件）
 * - SandboxActivity 状态机（03 §6.1）：pending → dirty → snapped →
 *   committed | rolledback → closed；快照落 <ws>/.ponda/sandbox/activities.json
 * - 结算（03 §6.2）：用户确认后以 `ponda(<task|session>): <摘要>` 提交到当前分支
 * - 回滚：reset --hard 到某快照（快照即普通 git 对象，用户也可手工 git checkout）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureGit, git, isGitRepo, rollback, snapshot, snapshotLog } from "../../sandbox/src/gitops.ts";

export type ActivityState = "pending" | "dirty" | "snapped" | "committed" | "rolledback" | "closed";

export interface SandboxActivity {
	sessionId: string;
	workspace: string;
	state: ActivityState;
	turns: number; // 已快照轮数
	baseline: string | null; // 会话起点 HEAD（无 .git 自动 init 后的首提交）
	lastSnapshot: string | null; // 最近快照 commit
	createdAt: string;
	updatedAt: string;
}

interface ActivityFile {
	activities: SandboxActivity[];
}

export class InplaceSandboxTracker {
	private readonly file: string | null;
	private activities = new Map<string, SandboxActivity>();

	constructor(stateFile?: string) {
		this.file = stateFile ?? null;
		if (this.file !== null && existsSync(this.file)) {
			try {
				const parsed = JSON.parse(readFileSync(this.file, "utf8")) as ActivityFile;
				for (const a of parsed.activities ?? []) this.activities.set(a.sessionId, a);
			} catch {
				// 坏状态文件：空表起步（快照链本体在 git，不受影响）
			}
		}
	}

	private flush(): void {
		if (this.file === null) return;
		mkdirSync(dirname(this.file), { recursive: true });
		writeFileSync(
			this.file,
			`${JSON.stringify({ activities: [...this.activities.values()] }, null, "\t")}\n`,
			"utf8",
		);
	}

	get(sessionId: string): SandboxActivity | null {
		return this.activities.get(sessionId) ?? null;
	}

	list(): SandboxActivity[] {
		return [...this.activities.values()];
	}

	/** 会话首写前置（03 §5.1）：确保 git 仓库 + 记录 baseline */
	ensure(sessionId: string, workspace: string, opts: { autoGitInit: boolean }): SandboxActivity | null {
		const existing = this.activities.get(sessionId);
		if (existing !== undefined) return existing;
		const ensured = ensureGit(workspace, opts);
		if (ensured === null) return null; // 拒绝降级只读（策略由调用方提示）
		const head = git(workspace, ["rev-parse", "HEAD"]);
		const activity: SandboxActivity = {
			sessionId,
			workspace,
			state: "pending",
			turns: 0,
			baseline: head.ok ? head.stdout : null,
			lastSnapshot: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		this.activities.set(sessionId, activity);
		this.flush();
		return activity;
	}

	/**
	 * turn_end 快照（03 §5.2）：工作区有变更（含未跟踪）才提交 `ponda: auto: turn <n>`；
	 * 空轮保持原状态。返回 null 表示非 git 工作区（无快照链）。
	 */
	snapshotTurn(sessionId: string, workspace: string): { turn: number; commit: string } | null {
		if (!isGitRepo(workspace)) return null;
		let a = this.activities.get(sessionId);
		if (a === undefined) {
			const ensured = this.ensure(sessionId, workspace, { autoGitInit: true });
			if (ensured === null) return null;
			a = ensured;
		}
		if (a.workspace !== workspace) return null; // 会话换工作区：不跨区快照
		const status = git(workspace, ["status", "--porcelain"]);
		if (!status.ok || status.stdout.length === 0) return null; // 空轮：无变更不提交空快照
		if (a.state === "pending") a.state = "dirty";
		// 与上一快照内容相同（如变更未结算、后续轮无新修改）则不重复拍——
		// 保证快照链每个提交都是真实状态跃迁，/undo 回 turn-1 即上一真实状态
		const candidate = a.turns + 1;
		const r = snapshot(workspace, sessionId.slice(0, 8), `auto: turn ${candidate}`);
		if (!r.ok || r.commit === undefined) {
			a.updatedAt = new Date().toISOString();
			this.flush();
			return null;
		}
		if (a.lastSnapshot !== null) {
			const same = git(workspace, ["diff", "--quiet", a.lastSnapshot, r.commit]);
			if (same.ok) {
				// 内容未变：回退快照分支引用，不计数
				git(workspace, ["update-ref", `refs/heads/ponda/snapshots/${sessionId.slice(0, 8)}`, a.lastSnapshot]);
				a.updatedAt = new Date().toISOString();
				this.flush();
				return null;
			}
		}
		a.turns = candidate;
		a.state = "snapped";
		a.lastSnapshot = r.commit;
		a.updatedAt = new Date().toISOString();
		this.flush();
		return { turn: a.turns, commit: r.commit };
	}

	/** 结算（03 §6.2）：确认后以规范 message 提交到当前分支 → committed */
	settle(
		sessionId: string,
		summary: string,
		opts: { taskId?: string } = {},
	): { ok: boolean; detail: string; commit?: string } {
		const a = this.activities.get(sessionId);
		if (a === undefined) return { ok: false, detail: "无该会话的沙箱活动" };
		if (!isGitRepo(a.workspace)) return { ok: false, detail: "not a git repo" };
		const subject =
			opts.taskId !== undefined ? `ponda(${opts.taskId.slice(0, 8)})` : `ponda(${sessionId.slice(0, 8)})`;
		const message = `${subject}: ${summary}`;
		const add = git(a.workspace, ["add", "-A"]);
		if (!add.ok) return { ok: false, detail: add.stderr };
		const body = `env-session: ${sessionId}\nactivity-state: ${a.state}\nturns: ${a.turns}\nsnapshot-range: ${a.lastSnapshot ?? "-"}`;
		const commit = git(a.workspace, [
			"-c",
			"user.name=ponda",
			"-c",
			"user.email=ponda@local",
			"commit",
			"-q",
			"-m",
			message,
			"-m",
			body,
		]);
		if (!commit.ok) return { ok: false, detail: commit.stderr };
		a.state = "committed";
		a.updatedAt = new Date().toISOString();
		this.flush();
		const head = git(a.workspace, ["rev-parse", "HEAD"]);
		return { ok: true, detail: message, commit: head.ok ? head.stdout : undefined };
	}

	/** 回滚到指定轮次快照 / baseline（03 §6.2；reset --hard，调用方已获用户确认） */
	rollbackTo(sessionId: string, target: { turn?: number; baseline?: boolean }): { ok: boolean; detail: string } {
		const a = this.activities.get(sessionId);
		if (a === undefined) return { ok: false, detail: "无该会话的沙箱活动" };
		if (target.baseline) {
			if (a.baseline === null) return { ok: false, detail: "无 baseline 记录" };
			const r = rollback(a.workspace, sessionId, a.baseline);
			if (!r.ok) return r;
		} else {
			const turn = target.turn;
			if (turn === undefined) return { ok: false, detail: "须指定 --turn <n> 或 --baseline" };
			const log = snapshotLog(a.workspace, sessionId.slice(0, 8));
			const hit = log.find((e) => e.message === `ponda: auto: turn ${turn}`);
			if (hit === undefined) return { ok: false, detail: `快照 turn ${turn} 不存在（共 ${log.length} 个快照）` };
			const r = rollback(a.workspace, sessionId, hit.commit);
			if (!r.ok) return r;
		}
		a.state = "rolledback";
		a.updatedAt = new Date().toISOString();
		this.flush();
		return { ok: true, detail: `已回滚（${target.baseline ? "baseline" : `turn ${target.turn}`}）` };
	}

	/** 结算差异摘要（确认界面展示）：工作区未提交变更（含未跟踪） */
	pendingChanges(sessionId: string): { status: string; path: string }[] {
		const a = this.activities.get(sessionId);
		if (a === undefined) return [];
		const r = git(a.workspace, ["status", "--porcelain"]);
		if (!r.ok) return [];
		return r.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => ({
				status: line.slice(0, 2).trim(),
				path: line.slice(3),
			}));
	}
}

/** 状态文件位置：<workspace>/.ponda/sandbox/activities.json */
export function activitiesFile(workspace: string): string {
	return join(workspace, ".ponda", "sandbox", "activities.json");
}
