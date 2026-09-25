/**
 * ETL：事件流 events/<date>.jsonl → metrics.db 五表（design: 07-data.md §4）。
 * 游标表记录每个文件的消费行号——重放幂等（07：游标表记录消费位点，幂等）。
 * 触发：daemon 优雅退出时 / `ponda stats rebuild [--from <date>]`。
 * 不聚合的事件类型（swarm.cell/env.switch/resource.change/compaction/
 * container.lifecycle/error）保留在事件流中，表结构后置（07 §8 边界）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MetricsDb } from "./db.ts";
import type { TelemetryEvent } from "./index.ts";

export interface EtlResult {
	files: number;
	events: number;
	skipped: number; // 游标之前已消费的行
}

/** 消费事件目录（按文件名排序）；from 之后的文件重新从 0 行消费（rebuild 用） */
export function runEtl(db: MetricsDb, eventsDir: string, opts: { from?: string } = {}): EtlResult {
	const result: EtlResult = { files: 0, events: 0, skipped: 0 };
	if (!existsSync(eventsDir)) return result;
	const files = readdirSync(eventsDir)
		.filter((f) => f.endsWith(".jsonl"))
		.sort();
	for (const file of files) {
		if (opts.from !== undefined && file < `${opts.from}.jsonl`) continue;
		const path = join(eventsDir, file);
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		// --from：该日期及之后的文件游标归零重放（rebuild 语义）
		const cursor = opts.from !== undefined ? 0 : db.getCursor(file);
		if (cursor >= lines.length) {
			result.files++;
			result.skipped += lines.length;
			continue;
		}
		for (let i = cursor; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			let e: TelemetryEvent;
			try {
				e = JSON.parse(line) as TelemetryEvent;
			} catch {
				continue; // 坏行跳过
			}
			applyEvent(db, e);
			result.events++;
		}
		db.setCursor(file, lines.length);
		result.files++;
		result.skipped += cursor;
	}
	return result;
}

function applyEvent(db: MetricsDb, e: TelemetryEvent): void {
	const p = (e.payload ?? {}) as Record<string, unknown>;
	switch (e.type) {
		case "session.start":
			db.upsertSessionStart({
				sessionId: e.sessionId ?? (typeof p.sessionId === "string" ? p.sessionId : `orphan-${e.id}`),
				env: e.env,
				workspace: typeof p.workspace === "string" ? p.workspace : null,
				model: typeof p.model === "string" ? p.model : null,
				startedAt: e.ts,
			});
			return;
		case "session.end": {
			const sid = e.sessionId ?? `orphan-${e.id}`;
			db.setSessionEnd(sid, e.env, e.ts, typeof p.reason === "string" ? (p.reason as string) : "unknown");
			return;
		}
		case "message": {
			const sid = e.sessionId ?? `orphan-${e.id}`;
			const tokens = (p.tokens ?? {}) as { input?: number; output?: number };
			db.addSessionUsage(
				sid,
				e.env,
				tokens.input ?? 0,
				tokens.output ?? 0,
				typeof p.costUsd === "number" ? p.costUsd : 0,
				1,
			);
			db.addCostDaily(
				e.ts.slice(0, 10),
				e.env,
				tokens.input ?? 0,
				tokens.output ?? 0,
				typeof p.costUsd === "number" ? p.costUsd : 0,
			);
			return;
		}
		case "tool.call": {
			if (e.sessionId !== null) db.addSessionToolCalls(e.sessionId, e.env, 1);
			return;
		}
		case "skill.invoke": {
			db.addSkillInvoke({
				env: e.env,
				skill: typeof p.skillName === "string" ? p.skillName : "unknown",
				success: p.success !== false,
				tokens: typeof p.tokens === "number" ? p.tokens : 0,
				costUsd: typeof p.costUsd === "number" ? p.costUsd : 0,
			});
			return;
		}
		case "task.lifecycle": {
			if (e.taskId === null && typeof p.taskId !== "string") return;
			db.upsertTask({
				taskId: (e.taskId ?? p.taskId) as string,
				env: e.env,
				goal: typeof p.goal === "string" ? p.goal : undefined,
				phase: typeof p.phase === "string" ? p.phase : undefined,
				updatedAt: e.ts,
			});
			return;
		}
		case "deliverable.verify": {
			if (e.taskId === null && typeof p.taskId !== "string") return;
			db.addTaskVerify(
				(e.taskId ?? p.taskId) as string,
				e.env,
				p.passed === true,
				typeof p.deliverables === "number" ? p.deliverables : 0,
			);
			return;
		}
		case "permission.request":
			db.addPermissionRequest(e.env, typeof p.privilege === "string" ? p.privilege : "unknown");
			return;
		case "permission.decision": {
			const decision = typeof p.decision === "string" ? p.decision : "deny";
			db.addPermissionDecision(e.env, typeof p.privilege === "string" ? p.privilege : "unknown", decision);
			return;
		}
		default:
			// 其余事件类型保留在事件流（聚合后置于后续里程碑）
			return;
	}
}

/** `ponda stats rebuild` 入口：打开（或复用）metrics.db 并跑一轮 ETL */
export function rebuildMetrics(dbPath: string, eventsDir: string, opts: { from?: string } = {}): EtlResult {
	const db = new MetricsDb(dbPath);
	try {
		return runEtl(db, eventsDir, opts);
	} finally {
		db.close();
	}
}
