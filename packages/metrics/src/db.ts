/**
 * metrics.db：SQLite（WAL）指标层（design: 07-data.md §4）。
 * 事件流的 ETL 物化主题：sessions / tasks / skill_stats / permission_stats /
 * cost_daily + etl_cursor（消费位点，幂等）。经 node:sqlite DatabaseSync，
 * 无外部依赖。所有写入为 UPSERT，ETL 重放安全。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SessionRow {
	session_id: string;
	env: string;
	workspace: string | null;
	model: string | null;
	started_at: string | null;
	ended_at: string | null;
	end_reason: string | null;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
	message_count: number;
	tool_calls: number;
}

export interface TaskRow {
	task_id: string;
	env: string;
	goal: string | null;
	phase: string | null;
	verified: number;
	failed: number;
	deliverables: number;
	verify_attempts: number;
	updated_at: string | null;
}

export interface SkillStatRow {
	env: string;
	skill: string;
	invokes: number;
	success: number;
	retries: number;
	rollbacks: number;
	interventions: number;
	tokens: number;
	cost_usd: number;
}

export interface PermissionStatRow {
	env: string;
	privilege: string;
	requests: number;
	approved: number;
	denied: number;
	env_always: number;
}

export interface CostDailyRow {
	day: string;
	env: string;
	input_tokens: number;
	output_tokens: number;
	cost_usd: number;
}

export class MetricsDb {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
	session_id TEXT PRIMARY KEY,
	env TEXT NOT NULL,
	workspace TEXT,
	model TEXT,
	started_at TEXT,
	ended_at TEXT,
	end_reason TEXT,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	message_count INTEGER NOT NULL DEFAULT 0,
	tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
	task_id TEXT PRIMARY KEY,
	env TEXT NOT NULL,
	goal TEXT,
	phase TEXT,
	verified INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	deliverables INTEGER NOT NULL DEFAULT 0,
	verify_attempts INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT
);
CREATE TABLE IF NOT EXISTS skill_stats (
	env TEXT NOT NULL,
	skill TEXT NOT NULL,
	invokes INTEGER NOT NULL DEFAULT 0,
	success INTEGER NOT NULL DEFAULT 0,
	retries INTEGER NOT NULL DEFAULT 0,
	rollbacks INTEGER NOT NULL DEFAULT 0,
	interventions INTEGER NOT NULL DEFAULT 0,
	tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (env, skill)
);
CREATE TABLE IF NOT EXISTS permission_stats (
	env TEXT NOT NULL,
	privilege TEXT NOT NULL,
	requests INTEGER NOT NULL DEFAULT 0,
	approved INTEGER NOT NULL DEFAULT 0,
	denied INTEGER NOT NULL DEFAULT 0,
	env_always INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (env, privilege)
);
CREATE TABLE IF NOT EXISTS cost_daily (
	day TEXT NOT NULL,
	env TEXT NOT NULL,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	PRIMARY KEY (day, env)
);
CREATE TABLE IF NOT EXISTS etl_cursor (
	file TEXT PRIMARY KEY,
	line_no INTEGER NOT NULL
);
`);
	}

	close(): void {
		this.db.close();
	}

	exec(sql: string): void {
		this.db.exec(sql);
	}

	// —— sessions ——

	upsertSessionStart(s: {
		sessionId: string;
		env: string;
		workspace: string | null;
		model: string | null;
		startedAt: string;
	}): void {
		this.db
			.prepare(
				`INSERT INTO sessions (session_id, env, workspace, model, started_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 workspace = excluded.workspace, model = excluded.model, started_at = excluded.started_at`,
			)
			.run(s.sessionId, s.env, s.workspace, s.model, s.startedAt);
	}

	setSessionEnd(sessionId: string, env: string, endedAt: string, reason: string): void {
		this.db
			.prepare(
				`INSERT INTO sessions (session_id, env, ended_at, end_reason)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at, end_reason = excluded.end_reason`,
			)
			.run(sessionId, env, endedAt, reason);
	}

	addSessionUsage(
		sessionId: string,
		env: string,
		input: number,
		output: number,
		costUsd: number,
		messages: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO sessions (session_id, env, input_tokens, output_tokens, cost_usd, message_count)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				 input_tokens = input_tokens + excluded.input_tokens,
				 output_tokens = output_tokens + excluded.output_tokens,
				 cost_usd = ROUND(cost_usd + excluded.cost_usd, 6),
				 message_count = message_count + excluded.message_count`,
			)
			.run(sessionId, env, input, output, costUsd, messages);
	}

	addSessionToolCalls(sessionId: string, env: string, n: number): void {
		this.db
			.prepare(
				`INSERT INTO sessions (session_id, env, tool_calls)
				 VALUES (?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET tool_calls = tool_calls + excluded.tool_calls`,
			)
			.run(sessionId, env, n);
	}

	// —— tasks ——

	upsertTask(t: { taskId: string; env: string; goal?: string; phase?: string; updatedAt: string }): void {
		this.db
			.prepare(
				`INSERT INTO tasks (task_id, env, goal, phase, updated_at)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(task_id) DO UPDATE SET
				 goal = COALESCE(excluded.goal, goal),
				 phase = COALESCE(excluded.phase, phase),
				 updated_at = excluded.updated_at`,
			)
			.run(t.taskId, t.env, t.goal ?? null, t.phase ?? null, t.updatedAt);
	}

	addTaskVerify(taskId: string, env: string, passed: boolean, deliverables: number): void {
		this.db
			.prepare(
				`INSERT INTO tasks (task_id, env, verified, failed, deliverables, verify_attempts)
				 VALUES (?, ?, ?, ?, ?, 1)
				 ON CONFLICT(task_id) DO UPDATE SET
				 verified = verified + excluded.verified,
				 failed = failed + excluded.failed,
				 deliverables = MAX(deliverables, excluded.deliverables),
				 verify_attempts = verify_attempts + 1`,
			)
			.run(taskId, env, passed ? 1 : 0, passed ? 0 : 1, deliverables);
	}

	// —— skill_stats ——

	addSkillInvoke(s: { env: string; skill: string; success: boolean; tokens: number; costUsd: number }): void {
		this.db
			.prepare(
				`INSERT INTO skill_stats (env, skill, invokes, success, tokens, cost_usd)
				 VALUES (?, ?, 1, ?, ?, ?)
				 ON CONFLICT(env, skill) DO UPDATE SET
				 invokes = invokes + 1,
				 success = success + excluded.success,
				 tokens = tokens + excluded.tokens,
				 cost_usd = ROUND(cost_usd + excluded.cost_usd, 6)`,
			)
			.run(s.env, s.skill, s.success ? 1 : 0, s.tokens, s.costUsd);
	}

	// —— permission_stats ——

	addPermissionRequest(env: string, privilege: string): void {
		this.db
			.prepare(
				`INSERT INTO permission_stats (env, privilege, requests)
				 VALUES (?, ?, 1)
				 ON CONFLICT(env, privilege) DO UPDATE SET requests = requests + 1`,
			)
			.run(env, privilege);
	}

	addPermissionDecision(env: string, privilege: string, decision: string): void {
		const approved = decision === "once" || decision === "session" || decision === "env-always" ? 1 : 0;
		const envAlways = decision === "env-always" ? 1 : 0;
		const denied = decision === "deny" ? 1 : 0;
		this.db
			.prepare(
				`INSERT INTO permission_stats (env, privilege, requests, approved, denied, env_always)
				 VALUES (?, ?, 0, ?, ?, ?)
				 ON CONFLICT(env, privilege) DO UPDATE SET
				 approved = approved + excluded.approved,
				 denied = denied + excluded.denied,
				 env_always = env_always + excluded.env_always`,
			)
			.run(env, privilege, approved, denied, envAlways);
	}

	// —— cost_daily ——

	addCostDaily(day: string, env: string, input: number, output: number, costUsd: number): void {
		this.db
			.prepare(
				`INSERT INTO cost_daily (day, env, input_tokens, output_tokens, cost_usd)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(day, env) DO UPDATE SET
				 input_tokens = input_tokens + excluded.input_tokens,
				 output_tokens = output_tokens + excluded.output_tokens,
				 cost_usd = ROUND(cost_usd + excluded.cost_usd, 6)`,
			)
			.run(day, env, input, output, costUsd);
	}

	// —— etl 游标 ——

	getCursor(file: string): number {
		const r = this.db.prepare("SELECT line_no FROM etl_cursor WHERE file = ?").get(file) as
			| { line_no: number }
			| undefined;
		return r?.line_no ?? 0;
	}

	setCursor(file: string, lineNo: number): void {
		this.db
			.prepare(
				`INSERT INTO etl_cursor (file, line_no) VALUES (?, ?)
				 ON CONFLICT(file) DO UPDATE SET line_no = excluded.line_no`,
			)
			.run(file, lineNo);
	}

	// —— 查询（stats CLI） ——

	querySessions(limit = 50): SessionRow[] {
		return this.db
			.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
			.all(limit) as unknown as SessionRow[];
	}

	queryTasks(limit = 50): TaskRow[] {
		return this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as TaskRow[];
	}

	querySkillStats(): SkillStatRow[] {
		return this.db.prepare("SELECT * FROM skill_stats ORDER BY invokes DESC").all() as unknown as SkillStatRow[];
	}

	queryPermissionStats(): PermissionStatRow[] {
		return this.db
			.prepare("SELECT * FROM permission_stats ORDER BY requests DESC")
			.all() as unknown as PermissionStatRow[];
	}

	queryCostDaily(limit = 30): CostDailyRow[] {
		return this.db
			.prepare("SELECT * FROM cost_daily ORDER BY day DESC LIMIT ?")
			.all(limit) as unknown as CostDailyRow[];
	}
}
