/** `ponda dataset export`：RL 数据集导出（design: 07-data.md §6；digest/full 两级） */

import { createHash } from "node:crypto";
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
	/** full 级：观察全文（07 §6；经脱敏通道） */
	text?: string;
}

interface RewardSignals {
	taskComplete: boolean;
	verificationPassRate: number;
	costUsd: number;
	totalTokens: number;
	steps: number;
	rollbacks: number;
	humanInterventions: number;
	retries: number;
}

interface TrajectorySample {
	taskId: string;
	/** EnvSnapshotRef（07 §6）：manifest 内容哈希——轨迹可归因到确切配置 */
	envSnapshot: { name: string; skills: string[]; snapshotRef: string };
	model: string;
	steps: TrajectoryStep[];
	outcome: { totalMessages: number; totalTokens: number; totalCostUsd: number };
	/** RewardSignals（07 §6）：接口冻结，权重由训练侧决定 */
	reward: RewardSignals;
}

export async function runDataset(
	store: EnvStore,
	action: string,
	_args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	const out = typeof flags.get("out") === "string" ? (flags.get("out") as string) : "./ponda-dataset";

	if (action !== "export") {
		console.error("可用动作：export [--env E] [--out <dir>] [--level digest|full]（full 需 --yes 确认）");
		return 1;
	}
	const level = flags.get("level") === "full" || flags.get("full") === true ? "full" : "digest";
	if (level === "full" && flags.get("yes") !== true) {
		console.error(c.yellow("full 级含观察全文；确认请加 --yes（07 §6 二次确认）"));
		return 4;
	}

	// 收集环境全部会话 → 轨迹样本（digest 级不含观察全文，安全默认）
	const dir = join(paths.env(store.home, env), "sessions");
	if (!existsSync(dir)) {
		console.log(c.dim(`环境 ${env} 无会话数据`));
		return 0;
	}
	const manifest = store.resolve(env);
	const skillsList = manifest.effective.skills.map(String);
	const snapshotRef = `sha256:${createHash("sha256")
		.update(JSON.stringify(manifest.effective))
		.digest("hex")
		.slice(0, 16)}`;
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
					...(level === "full" ? { text } : {}),
				});
				if (e.message.usage) {
					totalTokens += (e.message.usage.input ?? 0) + (e.message.usage.output ?? 0);
					totalCost += e.message.usage.cost?.total ?? 0;
				}
			}
		} catch {
			continue;
		}
		const costUsd = Math.round(totalCost * 1e6) / 1e6;
		samples.push({
			taskId: sessionId,
			envSnapshot: { name: env, skills: skillsList, snapshotRef },
			model,
			steps,
			outcome: { totalMessages: steps.length, totalTokens, totalCostUsd: costUsd },
			reward: {
				taskComplete: false,
				verificationPassRate: 0,
				costUsd,
				totalTokens,
				steps: steps.length,
				rollbacks: 0,
				humanInterventions: 0,
				retries: 0,
			},
		});
	}

	// 导出
	mkdirSync(out, { recursive: true });
	const file = join(out, "trajectories.jsonl");
	writeFileSync(file, `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");
	writeFileSync(
		join(out, "manifest.json"),
		JSON.stringify(
			{ env, exportedAt: new Date().toISOString(), samples: samples.length, level, snapshotRef },
			null,
			"\t",
		),
		"utf8",
	);

	if (json) {
		console.log(JSON.stringify({ file, samples: samples.length, level, snapshotRef }));
	} else {
		console.log(c.green("✓"), `导出 ${samples.length} 条轨迹 → ${file}`);
		console.log(
			c.dim(`  级别：${level}${level === "full" ? "（含观察全文）" : "（仅摘要哈希；full 级 --level full --yes）"}`),
		);
		console.log(c.dim(`  EnvSnapshotRef：${snapshotRef}`));
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
