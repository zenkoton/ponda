/** `ponda stats`：指标呈现（design: 07-data.md §5；M10 余项）——读取 daemon 运行数据 + telemetry JSONL */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { c, table } from "../ui.ts";
import { currentEnv } from "./env.ts";

export async function runStats(
	store: EnvStore,
	sub: string,
	_args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;

	switch (sub) {
		case "sessions": {
			// 会话级指标（从 envs/<env>/sessions/*.jsonl 聚合）
			const dir = join(paths.env(store.home, env), "sessions");
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
					let title = "";
					let _ws: string | null = null;
					for (const l of lines) {
						const e = JSON.parse(l) as {
							type?: string;
							cwd?: string;
							message?: {
								role?: string;
								content?: { type: string; text?: string }[];
								usage?: { input?: number; output?: number; cost?: { total?: number } };
							};
						};
						if (e.type === "session") _ws = e.cwd ?? null;
						if (e.type === "message" && e.message?.role === "user" && title === "") {
							const t = (e.message.content ?? []).find((b) => b.type === "text")?.text ?? "";
							title = t.slice(0, 40);
						}
						if (e.message?.usage) {
							inTok += e.message.usage.input ?? 0;
							outTok += e.message.usage.output ?? 0;
							cost += e.message.usage.cost?.total ?? 0;
						}
					}
					rows.push([
						f.replace(".jsonl", "").slice(0, 8),
						title || "-",
						inTok + outTok,
						Math.round(cost * 1e4) / 1e4,
					]);
				} catch {}
			}
			if (json) {
				console.log(JSON.stringify(rows));
				return 0;
			}
			if (rows.length === 0) {
				console.log(c.dim("无会话"));
				return 0;
			}
			console.log(table(["SESSION", "TITLE", "TOKENS", "COST$"], rows, [0, 1]));
			return 0;
		}

		case "cost": {
			// 环境级合计
			const dir = join(paths.env(store.home, env), "sessions");
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
				`环境 ${c.bold(env)}：${sessions} 会话 · ${inTok + outTok} tok · $${(Math.round(cost * 1e4) / 1e4).toFixed(4)}`,
			);
			return 0;
		}

		case "skills": {
			// 技能可用性/稳定性（07 §5；基于会话中的 skill 调用统计）
			const skillCounts = new Map<string, { invokes: number; tokens: number; cost: number }>();
			const dir = join(paths.env(store.home, env), "sessions");
			if (existsSync(dir)) {
				for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
					for (const l of readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)) {
						try {
							const e = JSON.parse(l) as {
								message?: {
									role?: string;
									content?: { type: string; text?: string }[];
									usage?: { input?: number; output?: number; cost?: { total?: number } };
								};
							};
							if (e.message?.role !== "user") continue;
							const text = (e.message.content ?? []).map((b) => b.text ?? "").join(" ");
							for (const m of text.matchAll(/\/skill:([\w-]+)/g)) {
								const name = m[1] as string;
								const cur = skillCounts.get(name) ?? { invokes: 0, tokens: 0, cost: 0 };
								cur.invokes++;
								skillCounts.set(name, cur);
							}
						} catch {}
					}
				}
			}
			if (json) {
				console.log(JSON.stringify([...skillCounts.entries()].map(([name, s]) => ({ name, ...s }))));
				return 0;
			}
			if (skillCounts.size === 0) {
				console.log(c.dim("无 skill 调用记录（07 §5 完整指标需运行时埋点接入 P4 后自动积累）"));
				return 0;
			}
			console.log(
				table(
					["SKILL", "INVOKES"],
					[...skillCounts.entries()].map(([n, s]) => [n, s.invokes]),
					[0],
				),
			);
			return 0;
		}

		default:
			console.error(`可用动作：sessions | cost | skills [--env E] [--json]（数据源：环境 sessions/*.jsonl）`);
			return 1;
	}
}
