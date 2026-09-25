/**
 * `ponda stats`：指标呈现（design: 07-data.md §4/§5）。
 * 数据源：metrics.db（事件流 ETL 物化的五表）；`stats rebuild` 全量重建，
 * daemon 退出时自动增量同步。旧 JSONL 扫描保留为无 db 时的回退。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { MetricsDb, rebuildMetrics } from "../../../metrics/src/index.ts";
import { c, table } from "../ui.ts";
import { currentEnv } from "./env.ts";

function metricsPath(home: string): string {
	return join(home, "telemetry", "metrics.db");
}

/** 事件流存在时增量 ETL（游标幂等）；返回 db（无事件流返回 null） */
function ensureDb(home: string): MetricsDb | null {
	const eventsDir = join(home, "telemetry", "events");
	if (!existsSync(eventsDir)) return null;
	rebuildMetrics(metricsPath(home), eventsDir);
	return new MetricsDb(metricsPath(home));
}

function readRetentionDays(home: string): number {
	try {
		const f = join(home, "ponda.json");
		if (!existsSync(f)) return 180;
		const cfg = JSON.parse(readFileSync(f, "utf8")) as { telemetry?: { retentionDays?: number } };
		return typeof cfg.telemetry?.retentionDays === "number" ? (cfg.telemetry.retentionDays as number) : 180;
	} catch {
		return 180;
	}
}

export async function runStats(
	store: EnvStore,
	sub: string,
	_args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;

	switch (sub) {
		case "rebuild": {
			const from = typeof flags.get("from") === "string" ? (flags.get("from") as string) : undefined;
			const eventsDir = join(store.home, "telemetry", "events");
			if (!existsSync(eventsDir)) {
				console.log(c.dim("无事件流（telemetry 默认关闭；ponda.json telemetry.enabled 开启后积累）"));
				return 0;
			}
			const r = rebuildMetrics(metricsPath(store.home), eventsDir, { from });
			if (json) {
				console.log(JSON.stringify({ db: metricsPath(store.home), ...r }));
				return 0;
			}
			console.log(c.green("✓"), `ETL 完成：${r.files} 文件 / ${r.events} 新事件（跳过已消费 ${r.skipped}）`);
			console.log(c.dim(`  ${metricsPath(store.home)}`));
			return 0;
		}

		case "prune": {
			// retention：清理超出保留期的事件流文件（07 §4；metrics.db 聚合保留）
			const retention = readRetentionDays(store.home);
			const eventsDir = join(store.home, "telemetry", "events");
			if (!existsSync(eventsDir)) {
				console.log(c.dim("无事件流"));
				return 0;
			}
			const cutoff = Date.now() - retention * 24 * 3600 * 1000;
			let removed = 0;
			for (const f of readdirSync(eventsDir)) {
				const p = join(eventsDir, f);
				if (statSync(p).mtimeMs < cutoff) {
					rmSync(p);
					removed++;
				}
			}
			console.log(c.green("✓"), `清理 ${removed} 个过期事件文件（retention ${retention} 天）`);
			return 0;
		}

		case "audit": {
			// 脱敏抽检（07 §3）：最近事件里密钥形状残留扫描
			const eventsDir = join(store.home, "telemetry", "events");
			if (!existsSync(eventsDir)) {
				console.log(c.dim("无事件流"));
				return 0;
			}
			const files = readdirSync(eventsDir).sort();
			const last = files[files.length - 1];
			if (last === undefined) {
				console.log(c.dim("无事件"));
				return 0;
			}
			const events = readFileSync(join(eventsDir, last), "utf8")
				.split("\n")
				.filter(Boolean)
				.slice(-50)
				.map((l) => JSON.parse(l) as { type: string; scrubbed: Record<string, boolean> });
			const suspicious = events.filter((e) => {
				try {
					return /sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9]{10,}/.test(JSON.stringify(e));
				} catch {
					return false;
				}
			});
			const scrubbedCount = events.filter((e) => Object.values(e.scrubbed ?? {}).some(Boolean)).length;
			if (json) {
				console.log(
					JSON.stringify({ sampled: events.length, scrubbed: scrubbedCount, suspicious: suspicious.length }),
				);
				return 0;
			}
			console.log(`抽检 ${events.length} 条（${last}）：脱敏命中 ${scrubbedCount}，疑似残留 ${suspicious.length}`);
			if (suspicious.length > 0) {
				console.log(c.yellow("⚠ 存在疑似未脱敏密钥形状，检查 metrics scrub 配置"));
				return 1;
			}
			console.log(c.green("✓"), "无疑似残留");
			return 0;
		}

		case "sessions": {
			const db = ensureDb(store.home);
			if (db === null) return fallbackSessions(store.home, env, json);
			try {
				const rows = db
					.querySessions(30)
					.filter((r) => r.env === env)
					.map((r) => [
						r.session_id.slice(0, 8),
						r.model ?? "-",
						`${r.input_tokens + r.output_tokens}`,
						Math.round(r.cost_usd * 1e4) / 1e4,
						(r.end_reason ?? r.ended_at !== null) ? (r.end_reason ?? "-") : "live",
					]);
				if (json) {
					console.log(JSON.stringify(db.querySessions(30).filter((r) => r.env === env)));
					return 0;
				}
				if (rows.length === 0) {
					console.log(c.dim("无会话指标（telemetry 默认关闭；开启后积累）"));
					return 0;
				}
				console.log(table(["SESSION", "MODEL", "TOKENS", "COST$", "END"], rows, [0]));
				return 0;
			} finally {
				db.close();
			}
		}

		case "cost": {
			const db = ensureDb(store.home);
			if (db === null) return fallbackCost(store.home, env, json);
			try {
				const rows = db.queryCostDaily(90).filter((r) => r.env === env);
				if (json) {
					console.log(JSON.stringify(rows));
					return 0;
				}
				if (rows.length === 0) {
					console.log(c.dim("无成本数据"));
					return 0;
				}
				const totals = rows.reduce(
					(a, r) => ({
						input: a.input + r.input_tokens,
						output: a.output + r.output_tokens,
						cost: a.cost + r.cost_usd,
					}),
					{ input: 0, output: 0, cost: 0 },
				);
				console.log(`环境 ${c.bold(env)}（近 ${rows.length} 天有数据）：`);
				console.log(
					table(
						["DAY", "IN", "OUT", "COST$"],
						rows
							.slice(0, 15)
							.map((r) => [r.day, r.input_tokens, r.output_tokens, Math.round(r.cost_usd * 1e4) / 1e4]),
						[0],
					),
				);
				console.log(
					`合计：${totals.input + totals.output} tok · $${(Math.round(totals.cost * 1e6) / 1e6).toFixed(4)}`,
				);
				return 0;
			} finally {
				db.close();
			}
		}

		case "tasks": {
			const db = ensureDb(store.home);
			if (db === null) {
				console.log(c.dim("无事件流（telemetry 默认关闭）"));
				return 0;
			}
			try {
				const rows = db.queryTasks(30).filter((r) => r.env === env);
				if (json) {
					console.log(JSON.stringify(rows));
					return 0;
				}
				if (rows.length === 0) {
					console.log(c.dim("无任务指标"));
					return 0;
				}
				console.log(
					table(
						["TASK", "PHASE", "VERIFIED", "FAILED", "ATTEMPTS"],
						rows.map((r) => [r.task_id.slice(0, 8), r.phase ?? "-", r.verified, r.failed, r.verify_attempts]),
						[0],
					),
				);
				return 0;
			} finally {
				db.close();
			}
		}

		case "permissions": {
			const db = ensureDb(store.home);
			if (db === null) {
				console.log(c.dim("无事件流（telemetry 默认关闭）"));
				return 0;
			}
			try {
				const rows = db.queryPermissionStats().filter((r) => r.env === env);
				if (json) {
					console.log(JSON.stringify(rows));
					return 0;
				}
				if (rows.length === 0) {
					console.log(c.dim("无权限申请记录"));
					return 0;
				}
				console.log(
					table(
						["PRIVILEGE", "REQUESTS", "APPROVED", "DENIED", "ENV-ALWAYS"],
						rows.map((r) => {
							const approveRate = r.requests > 0 ? Math.round((r.approved / r.requests) * 100) : 0;
							return [r.privilege, r.requests, `${r.approved}（${approveRate}%）`, r.denied, r.env_always];
						}),
						[0],
					),
				);
				console.log(c.dim("  批准率过低说明权限策略过严（07 §5：据此调整环境 privileges）"));
				return 0;
			} finally {
				db.close();
			}
		}

		case "skills": {
			const db = ensureDb(store.home);
			if (db === null) return fallbackSkills(store.home, env, json);
			try {
				const rows = db.querySkillStats().filter((r) => r.env === env);
				if (json) {
					console.log(JSON.stringify(rows));
					return 0;
				}
				if (rows.length === 0) {
					console.log(c.dim("无 skill 调用指标（经 agent 工具 skill:* 调用后积累）"));
					return 0;
				}
				console.log(
					table(
						["SKILL", "INVOKES", "SUCCESS", "AVG TOK", "AVG COST$"],
						rows.map((r) => [
							r.skill,
							r.invokes,
							r.invokes > 0 ? `${Math.round((r.success / r.invokes) * 100)}%` : "-",
							r.invokes > 0 ? Math.round(r.tokens / r.invokes) : 0,
							r.invokes > 0 ? Math.round((r.cost_usd / r.invokes) * 1e6) / 1e6 : 0,
						]),
						[0],
					),
				);
				return 0;
			} finally {
				db.close();
			}
		}

		default:
			console.error(
				"可用动作：sessions | cost | tasks | permissions | skills [--env E] [--json]；rebuild [--from D] | prune | audit（07 §4/§5）",
			);
			return 1;
	}
}

// —— 无事件流时的回退（直接扫环境会话 JSONL） ——

function fallbackSessions(home: string, env: string, json: boolean): number {
	const dir = join(paths.env(home, env), "sessions");
	if (!existsSync(dir)) {
		console.log(c.dim(`环境 ${env} 无会话`));
		return 0;
	}
	const rows: (string | number)[][] = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		try {
			const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
			let inTok = 0;
			let outTok = 0;
			let cost = 0;
			for (const l of lines) {
				const e = JSON.parse(l) as {
					message?: { usage?: { input?: number; output?: number; cost?: { total?: number } } };
				};
				if (e.message?.usage) {
					inTok += e.message.usage.input ?? 0;
					outTok += e.message.usage.output ?? 0;
					cost += e.message.usage.cost?.total ?? 0;
				}
			}
			rows.push([f.replace(".jsonl", "").slice(0, 8), inTok + outTok, Math.round(cost * 1e4) / 1e4]);
		} catch {}
	}
	if (json) {
		console.log(JSON.stringify(rows));
		return 0;
	}
	console.log(c.dim("（无 metrics.db，回退扫描会话 JSONL；开启 telemetry 后自动走指标层）"));
	console.log(table(["SESSION", "TOKENS", "COST$"], rows, [0]));
	return 0;
}

function fallbackCost(home: string, env: string, json: boolean): number {
	const dir = join(paths.env(home, env), "sessions");
	if (!existsSync(dir)) {
		console.log(c.dim(`环境 ${env} 无数据`));
		return 0;
	}
	let inTok = 0;
	let outTok = 0;
	let cost = 0;
	let sessions = 0;
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		sessions++;
		for (const l of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
			try {
				const e = JSON.parse(l) as {
					message?: { usage?: { input?: number; output?: number; cost?: { total?: number } } };
				};
				if (e.message?.usage) {
					inTok += e.message.usage.input ?? 0;
					outTok += e.message.usage.output ?? 0;
					cost += e.message.usage.cost?.total ?? 0;
				}
			} catch {}
		}
	}
	if (json) {
		console.log(
			JSON.stringify({ env, sessions, input: inTok, output: outTok, costUsd: Math.round(cost * 1e6) / 1e6 }),
		);
		return 0;
	}
	console.log(
		`环境 ${c.bold(env)}：${sessions} 会话 · ${inTok + outTok} tok · $${(Math.round(cost * 1e4) / 1e4).toFixed(4)} ${c.dim("(回退扫描)")}`,
	);
	return 0;
}

function fallbackSkills(home: string, env: string, json: boolean): number {
	const skillCounts = new Map<string, number>();
	const dir = join(paths.env(home, env), "sessions");
	if (existsSync(dir)) {
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
			for (const l of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
				try {
					const e = JSON.parse(l) as {
						message?: { role?: string; content?: { type: string; text?: string }[] };
					};
					if (e.message?.role !== "user") continue;
					const text = (e.message.content ?? []).map((b) => b.text ?? "").join(" ");
					for (const m of text.matchAll(/\/skill:([\w-]+)/g)) {
						const name = m[1] as string;
						skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
					}
				} catch {}
			}
		}
	}
	if (json) {
		console.log(JSON.stringify([...skillCounts.entries()].map(([name, invokes]) => ({ name, invokes }))));
		return 0;
	}
	if (skillCounts.size === 0) {
		console.log(c.dim("无 skill 调用记录"));
		return 0;
	}
	console.log(c.dim("（回退扫描；完整指标需 telemetry 开启）"));
	console.log(table(["SKILL", "INVOKES"], [...skillCounts.entries()], [0]));
	return 0;
}
