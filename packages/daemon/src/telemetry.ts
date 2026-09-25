/**
 * daemon 运行时埋点（design: 07-data.md §2；M10 余项）。
 * DaemonCore 经此把 session/tool/task/swarm 事件写入 telemetry JSONL；
 * 脱敏同步执行，本地存储，默认开启（ponda.json telemetry.enabled 可关）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlSink, newEvent, type TelemetryEvent, type TelemetryEventType } from "../../metrics/src/index.ts";

export interface TelemetryOptions {
	home: string;
	env: string;
	enabled?: boolean;
}

export class DaemonTelemetry {
	private sink: JsonlSink | null = null;
	private readonly home: string;
	private readonly env: string;
	private readonly enabled: boolean;

	constructor(opts: TelemetryOptions) {
		this.home = opts.home;
		this.env = opts.env;
		this.enabled = opts.enabled ?? readEnabled(opts.home);
		if (this.enabled) {
			this.sink = new JsonlSink({
				dir: join(opts.home, "telemetry"),
				scrub: { home: opts.home },
			});
		}
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 埋点入口（脱敏在 sink.push 内同步执行） */
	emit(
		type: TelemetryEventType,
		payload: Record<string, unknown>,
		ctx: { sessionId?: string | null; agentId?: string | null; taskId?: string | null } = {},
	): TelemetryEvent | null {
		if (this.sink === null) return null;
		return this.sink.push(newEvent(type, payload, { env: this.env, ...ctx }));
	}

	close(): void {
		this.sink?.close();
	}
}

function readEnabled(home: string): boolean {
	try {
		const f = join(home, "ponda.json");
		if (!existsSync(f)) return true;
		const cfg = JSON.parse(readFileSync(f, "utf8")) as { telemetry?: { enabled?: boolean } };
		return cfg.telemetry?.enabled ?? true;
	} catch {
		return true;
	}
}
