/** `ponda dataset export`：RL 数据集导出（design: 07-data.md §6；M10 余项） */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { c } from "../ui.ts";
import { currentEnv } from "./env.ts";

interface TrajectoryStep {
	step: number;
	role: string;
	textDigest: string;
	usageDigest: string;
}

interface TrajectorySample {
	taskId: string;
	envSnapshot: { name: string; skills: string[] };
	model: string;
	steps: TrajectoryStep[];
	outcome: { totalMessages: number; totalTokens: number; totalCostUsd: number };
}

export async function runDataset(
	store: EnvStore,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : `./ponda-dataset`;

	if (action !== "export") {
		console.error("可用动作：export [--env E] [--out <dir>]");
		return 1;
	}

	// 收集环境全部会话 → 轨迹样本（digest 级：不含观察全文，安全默认）
	const dir = join(paths.env(store.home, env), "sessions");
	if (!existsSync(dir)) {
		console.log(c.dim(`环境 ${env} 无会话数据`));
		return 0;
	}
	const manifest = store.resolve(env);
	const samples: TrajectorySample[] = [];

	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		const sessionId = f.replace(".jsonl", "");
		const steps: TrajectoryStep[] = [];
		let totalTokens = 0;
		let totalCost = 0;
		let model = "";
		try {
			const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
			for (const l of lines) {
				const e = JSON.parse(l) as {
					type?: string;
					provider?: string;
					modelId?: string;
					message?: {
						role?: string;
						content?: { type: string; text?: string }[];
						usage?: { input?: number; output?: number; cost?: { total?: number } };
					};
				};
				if (e.type === "session") model = `${e.provider ?? ""}/${e.modelId ?? ""}`;
				if (e.type !== "message" || e.message === undefined) continue;
				const text = (e.message.content ?? [])
					.filter((b) => b.type === "text")
					.map((b) => b.text ?? "")
					.join(" ");
				steps.push({
					step: steps.length,
					role: e.message.role ?? "unknown",
					textDigest: `${text.length}ch:${hashDigest(text)}`,
					usageDigest: e.message.usage ? `${e.message.usage.input ?? 0}in/${e.message.usage.output ?? 0}out` : "-",
				});
				if (e.message.usage) {
					totalTokens += (e.message.usage.input ?? 0) + (e.message.usage.output ?? 0);
					totalCost += e.message.usage.cost?.total ?? 0;
				}
			}
		} catch {
			continue;
		}
		samples.push({
			taskId: sessionId,
			envSnapshot: { name: env, skills: manifest.effective.skills.map(String) },
			model,
			steps,
			outcome: { totalMessages: steps.length, totalTokens, totalCostUsd: Math.round(totalCost * 1e6) / 1e6 },
		});
	}

	// 导出
	mkdirSync(out, { recursive: true });
	const file = join(out, "trajectories.jsonl");
	writeFileSync(file, samples.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
	writeFileSync(
		join(out, "manifest.json"),
		JSON.stringify(
			{ env, exportedAt: new Date().toISOString(), samples: samples.length, level: "digest" },
			null,
			"\t",
		),
		"utf8",
	);

	if (json) {
		console.log(JSON.stringify({ file, samples: samples.length }));
	} else {
		console.log(c.green("✓"), `导出 ${samples.length} 条轨迹 → ${file}`);
		console.log(c.dim("  级别：digest（仅摘要哈希；full 级需 --full 并经二次脱敏确认）"));
	}
	return 0;
}

function hashDigest(text: string): string {
	let h = 0;
	for (let i = 0; i < text.length; i++) {
		h = (h * 31 + text.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36).slice(0, 8);
}
