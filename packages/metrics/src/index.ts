/**
 * ponda 数据捕捉：事件模型、脱敏、JSONL sink、技能指标聚合（design: 07-data.md）。
 * 原则：本地优先、默认关闭、写入前同步脱敏；会话 JSONL 是事实源，本层是派生加速层。
 */
import { ulid } from "./ulid.ts";

// —— 事件模型（07 §2 表格的 M10 落地子集） ——

export type TelemetryEventType =
	| "session.start"
	| "session.end"
	| "message"
	| "tool.call"
	| "tool.result"
	| "skill.invoke"
	| "state.patch"
	| "task.lifecycle"
	| "deliverable.verify"
	| "permission.request"
	| "permission.decision"
	| "sandbox.settle"
	| "container.lifecycle"
	| "swarm.cell"
	| "env.switch"
	| "resource.change"
	| "compaction"
	| "error";

export interface ScrubReport {
	paths: boolean;
	envVars: boolean;
	secrets: boolean;
}

export interface TelemetryEvent<P = unknown> {
	id: string; // ulid
	ts: string; // ISO 8601
	env: string;
	sessionId: string | null;
	agentId: string | null;
	taskId: string | null;
	type: TelemetryEventType;
	payload: P;
	scrubbed: ScrubReport;
}

export function newEvent(
	type: TelemetryEventType,
	payload: unknown,
	ctx: { env: string; sessionId?: string | null; agentId?: string | null; taskId?: string | null },
): TelemetryEvent {
	return {
		id: ulid(),
		ts: new Date().toISOString(),
		env: ctx.env,
		sessionId: ctx.sessionId ?? null,
		agentId: ctx.agentId ?? null,
		taskId: ctx.taskId ?? null,
		type,
		payload,
		scrubbed: { paths: false, envVars: false, secrets: false },
	};
}

// —— 脱敏（07 §3；写入前同步执行） ——

const HIGH_ENTROPY = /[A-Za-z0-9_-]{20,}/;
const SECRET_SHAPE = /(api[_-]?key|token|secret|password|authorization|bearer)/i;
const REDACTED = "<redacted>";

export interface ScrubConfig {
	home: string; // 家目录 → "~"
	workspace?: string;
}

export function scrubString(s: string, cfg: ScrubConfig): { value: string; hit: ScrubReport } {
	const hit: ScrubReport = { paths: false, envVars: false, secrets: false };
	let value = s;
	// 长路径优先：workspace 先于 home（否则家目录替换会让 workspace 前缀失配）
	if (cfg.workspace && value.includes(cfg.workspace)) {
		value = value.split(cfg.workspace).join("<ws>");
		hit.paths = true;
	}
	if (value.includes(cfg.home)) {
		value = value.split(cfg.home).join("~");
		hit.paths = true;
	}
	// KEY=VALUE / --token=x / Bearer xxx 形态
	value = value.replace(
		/([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_-]*\s*[=:]\s*)(\S+)/gi,
		(_m, k) => {
			hit.secrets = true;
			return `${k}${REDACTED}`;
		},
	);
	value = value.replace(/\b(bearer)\s+\S+/gi, (_m) => {
		hit.secrets = true;
		return `bearer ${REDACTED}`;
	});
	return { value, hit };
}

/** 递归脱敏 payload（字符串节点逐个处理；高熵字符串启发式替换） */
export function scrubPayload<T>(payload: T, cfg: ScrubConfig): { value: T; hit: ScrubReport } {
	const hit: ScrubReport = { paths: false, envVars: false, secrets: false };
	const absorb = (h: ScrubReport) => {
		hit.paths ||= h.paths;
		hit.envVars ||= h.envVars;
		hit.secrets ||= h.secrets;
	};
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const r = scrubString(v, cfg);
			if (!r.hit.paths && !r.hit.secrets && HIGH_ENTROPY.test(v) && SECRET_SHAPE.test(v)) {
				absorb({ paths: false, envVars: false, secrets: true });
				return REDACTED;
			}
			absorb(r.hit);
			return r.value;
		}
		if (Array.isArray(v)) return v.map(walk);
		if (v !== null && typeof v === "object") {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
				if (SECRET_SHAPE.test(k) && typeof val === "string" && val.length > 0) {
					absorb({ paths: false, envVars: false, secrets: true });
					out[k] = REDACTED;
					continue;
				}
				out[k] = walk(val);
			}
			return out;
		}
		return v;
	};
	return { value: walk(payload) as T, hit };
}

// —— JSONL sink（07 §2 写入策略：内存队列 + 批量 fsync） ——

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SinkOptions {
	/** 事件根目录（默认 <home>/telemetry） */
	dir: string;
	/** 脱敏配置 */
	scrub: ScrubConfig;
	flushIntervalMs?: number; // 默认 500
	flushThreshold?: number; // 默认 64
}

export class JsonlSink {
	private queue: string[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private readonly opts: SinkOptions;

	constructor(opts: SinkOptions) {
		this.opts = opts;
		mkdirSync(opts.dir, { recursive: true });
		mkdirSync(join(opts.dir, "events"), { recursive: true });
	}

	/** 写入前同步脱敏；返回落盘前的事件（含 scrubbed 标记） */
	push(event: TelemetryEvent): TelemetryEvent {
		if (this.closed) throw new Error("sink closed");
		const { value, hit } = scrubPayload(event.payload, this.opts.scrub);
		const scrubbedEvent: TelemetryEvent = { ...event, payload: value, scrubbed: hit };
		this.queue.push(JSON.stringify(scrubbedEvent));
		if (this.queue.length >= (this.opts.flushThreshold ?? 64)) this.flush();
		else this.ensureTimer();
		return scrubbedEvent;
	}

	private ensureTimer(): void {
		if (this.timer === null) {
			this.timer = setTimeout(() => this.flush(), this.opts.flushIntervalMs ?? 500);
			this.timer.unref?.();
		}
	}

	flush(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.queue.length === 0) return;
		const day = new Date().toISOString().slice(0, 10);
		const file = join(this.opts.dir, "events", `${day}.jsonl`);
		appendFileSync(file, `${this.queue.join("\n")}\n`, "utf8");
		this.queue = [];
	}

	close(): void {
		this.flush();
		this.closed = true;
	}
}

/** 读取某日事件（分析/测试用） */
export function readEvents(dir: string, day: string): TelemetryEvent[] {
	const file = join(dir, "events", `${day}.jsonl`);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as TelemetryEvent);
}

// —— 技能可用性/稳定性指标（07 §5 表格的滚动窗口聚合） ——

export interface SkillStatInput {
	skillName: string;
	version: string;
	invokedAt: string; // ISO
	/** 调用后 5 轮内成败回填（由采集点判定） */
	success: boolean;
	retriedWithin10min: boolean;
	rollbackInvolved: boolean;
	humanIntervention: boolean;
	tokens: number;
	costUsd: number;
}

export interface SkillStat {
	skillName: string;
	version: string;
	invokes: number;
	successRate: number;
	retryRate: number;
	rollbackRate: number;
	humanInterventionRate: number;
	avgTokensPerInvoke: number;
	avgCostPerInvoke: number;
}

/** 按月滚动窗口聚合（07 §5；窗口语义由调用方过滤后传入） */
export function aggregateSkillStats(samples: SkillStatInput[]): SkillStat[] {
	const groups = new Map<string, SkillStatInput[]>();
	for (const s of samples) {
		const key = `${s.skillName}@${s.version}`;
		const arr = groups.get(key) ?? [];
		arr.push(s);
		groups.set(key, arr);
	}
	return [...groups.entries()]
		.map(([key, arr]) => {
			const [skillName, version] = key.split("@");
			const n = arr.length;
			const rate = (f: (s: SkillStatInput) => boolean) => arr.filter(f).length / n;
			return {
				skillName,
				version,
				invokes: n,
				successRate: Math.round(rate((s) => s.success) * 1000) / 1000,
				retryRate: Math.round(rate((s) => s.retriedWithin10min) * 1000) / 1000,
				rollbackRate: Math.round(rate((s) => s.rollbackInvolved) * 1000) / 1000,
				humanInterventionRate: Math.round(rate((s) => s.humanIntervention) * 1000) / 1000,
				avgTokensPerInvoke: Math.round(arr.reduce((a, s) => a + s.tokens, 0) / n),
				avgCostPerInvoke: Math.round((arr.reduce((a, s) => a + s.costUsd, 0) / n) * 1e6) / 1e6,
			};
		})
		.sort((a, b) => b.invokes - a.invokes);
}

// —— metrics.db 指标层与 ETL（07 §4）——
export * from "./db.ts";
export * from "./etl.ts";
