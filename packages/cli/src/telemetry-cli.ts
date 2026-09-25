/**
 * CLI 侧 telemetry 埋点（07 §2：env.switch / resource.change / sandbox.settle）。
 * 遵循同一开关与脱敏通道：~/.ponda/ponda.json telemetry.enabled（默认关闭）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlSink, newEvent, type TelemetryEventType } from "../../metrics/src/index.ts";

function telemetryEnabled(home: string): boolean {
	try {
		const f = join(home, "ponda.json");
		if (!existsSync(f)) return false;
		const cfg = JSON.parse(readFileSync(f, "utf8")) as { telemetry?: { enabled?: boolean } };
		return cfg.telemetry?.enabled ?? false;
	} catch {
		return false;
	}
}

export function emitCliEvent(
	home: string,
	env: string,
	type: TelemetryEventType,
	payload: Record<string, unknown>,
): void {
	if (!telemetryEnabled(home)) return;
	const sink = new JsonlSink({ dir: join(home, "telemetry"), scrub: { home } });
	sink.push(newEvent(type, payload, { env }));
	sink.close();
}
