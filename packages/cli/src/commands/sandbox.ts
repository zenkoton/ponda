/** `ponda sandbox`：临时工作区结算与清理（design: 03 §4/§8）。快照/回滚面向工作区 git，见 packages/sandbox。 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import { paths } from "../../../core/src/paths.ts";
import { refreshWiki } from "../../../core/src/wiki.ts";
import { InplaceSandboxTracker } from "../../../daemon/src/sandbox-session.ts";
import {
	createSandbox,
	detectBackend,
	listSandboxes,
	loadSandbox,
	settleSandbox,
	snapshotLog,
} from "../../../sandbox/src/index.ts";
import { emitCliEvent } from "../telemetry-cli.ts";
import { c, table, truncate } from "../ui.ts";

export async function runSandbox(
	home: string,
	action: string,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	switch (action) {
		case "list":
		case "ls": {
			const sbs = listSandboxes(home);
			if (json) {
				console.log(JSON.stringify(sbs, null, 2));
				return 0;
			}
			if (sbs.length === 0) {
				console.log(c.dim("无待结算的临时工作区（工作区外文件操作时自动创建）"));
				return 0;
			}
			console.log(
				table(
					["ID", "CREATED", "FILES", "TARGETS"],
					sbs.map((s) => [
						s.id,
						s.createdAt.slice(0, 16).replace("T", " "),
						Object.keys(s.mappings).length,
						truncate(Object.keys(s.mappings).join(" "), 48),
					]),
					[0, 1, 3],
				),
			);
			return 0;
		}

		case "settle": {
			const id = args[0];
			if (!id) {
				console.error("用法：ponda sandbox settle <id> --apply | --discard [--file <path> ...]");
				return 1;
			}
			const dir = join(paths.sandboxes(home), id);
			const sb = loadSandbox(dir);
			if (sb === null) {
				console.error(`临时工作区不存在：${id}`);
				return 2;
			}
			const apply = flags.get("apply") === true;
			const discard = flags.get("discard") === true;
			if (apply === discard) {
				console.error("须且仅须指定 --apply 或 --discard（合并/写回必须人工确认，design: 03 §6.3）");
				return 1;
			}
			const fileFlag = flags.get("file");
			const result = settleSandbox(sb, apply ? "apply" : "discard", {
				home,
				apply: typeof fileFlag === "string" ? [fileFlag] : undefined,
			});
			emitCliEvent(home, process.env.PONDA_ACTIVE_ENV ?? "default", "sandbox.settle", {
				activityId: sb.id,
				mode: "temp-workspace",
				files: { nModified: result.files.filter((f) => f.applied).length, nTotal: result.files.length },
				outcome: result.outcome,
			});
			console.log(c.green("✓"), `结算完成（${result.outcome}）：`);
			for (const f of result.files) {
				console.log(
					`  ${f.applied ? c.green("written") : c.dim(f.changed ? "skipped" : "unchanged")}  ${f.realPath}${f.created ? c.dim("（新建）") : ""}`,
				);
			}
			for (const b of result.backups) console.log(c.dim(`  backup: ${b}`));
			return 0;
		}

		case "clean": {
			// 结算遗留（trash）清理由 ponda doctor --prune 承担；此处清理空/孤儿沙箱
			const sbs = listSandboxes(home);
			const dry = flags.get("dry-run") === true;
			let n = 0;
			for (const sb of sbs) {
				if (dry) console.log(`将清理 ${sb.id}`);
				else {
					const { rmSync } = await import("node:fs");
					rmSync(sb.dir, { recursive: true, force: true });
				}
				n++;
			}
			console.log(`${dry ? "[dry-run] " : ""}已清理 ${n} 个临时工作区`);
			return 0;
		}

		case "create": {
			// 手动/测试入口：agent 运行时由 sandbox-guard 自动调用
			const targets = args;
			if (targets.length === 0) {
				console.error("用法：ponda sandbox create <realPath>...（会话外手动创建；运行时由扩展自动创建）");
				return 1;
			}
			const sb = createSandbox("manual000", Date.now() % 10000, targets, home);
			console.log(c.green("✓"), `临时工作区 ${sb.id}`);
			for (const [real, virt] of Object.entries(sb.mappings)) {
				console.log(c.dim(`  ${real} → ${virt}`));
			}
			return 0;
		}

		case "backend": {
			// 容器后端探测（design: 03 §2.1；无运行时 → audit-only 降级态说明）
			const b = detectBackend();
			if (json) {
				console.log(
					JSON.stringify({ backend: b?.id ?? null, confinement: b !== null ? "container" : "audit-only" }),
				);
				return 0;
			}
			if (b === null) {
				console.log(c.yellow("未检测到 docker/podman"), c.dim("→ 沙箱降级为 audit-only（高危命令默认拒绝）"));
				return 0;
			}
			console.log(c.green("✓"), `容器后端：${b.id}（每会话容器 + overlayfs 审计可用）`);
			return 0;
		}

		// —— 模式 A inplace：快照链 / 结算 / 回滚（design: 03 §5.2/§6）——

		case "snapshots": {
			// 快照链查看：ponda sandbox snapshots [会话前缀]（缺省最近活动）
			const tracker = loadTracker(home, flags);
			const acts = tracker.list().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			const prefix = args[0];
			const target = prefix !== undefined ? acts.find((a) => a.sessionId.startsWith(prefix)) : acts[0];
			if (target === undefined) {
				console.log(c.dim("无沙箱活动（会话内发生文件修改后自动建立快照链）"));
				return 0;
			}
			const log = snapshotLog(target.workspace, target.sessionId.slice(0, 8));
			if (json) {
				console.log(JSON.stringify({ activity: target, snapshots: log }, null, 2));
				return 0;
			}
			console.log(c.bold(`会话 ${target.sessionId.slice(0, 8)}（${target.state}，${target.turns} 轮快照）`));
			if (log.length === 0) {
				console.log(c.dim("  无快照提交"));
				return 0;
			}
			console.log(
				table(
					["TURN", "COMMIT"],
					log.map((e) => [e.message.replace("ponda: ", ""), e.commit.slice(0, 8)]),
					[0, 1],
				),
			);
			console.log(c.dim("  回滚：ponda sandbox rollback <n> --session <前缀>；baseline 用 --baseline"));
			return 0;
		}

		case "commit": {
			// inplace 结算（03 §6.2）：变更清单 → 用户确认 → 规范提交 ponda(<task|session>): <摘要>
			const summary = args[0];
			if (!summary) {
				console.error("用法：ponda sandbox commit <一句话摘要> [--session <前缀>] [--task <taskId>]");
				return 1;
			}
			const tracker = loadTracker(home, flags);
			const acts = tracker.list().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			const prefix = typeof flags.get("session") === "string" ? (flags.get("session") as string) : undefined;
			const target = prefix !== undefined ? acts.find((a) => a.sessionId.startsWith(prefix)) : acts[0];
			if (target === undefined) {
				console.error("无沙箱活动（先在会话中产生修改）");
				return 2;
			}
			const changes = tracker.pendingChanges(target.sessionId);
			if (changes.length === 0) {
				console.log(c.dim("工作区无未提交变更（无需结算）"));
				return 0;
			}
			console.log(c.bold(`待结算变更（${changes.length} 个文件）：`));
			for (const ch of changes.slice(0, 20)) console.log(`  ${ch.status.padEnd(2)} ${truncate(ch.path, 70)}`);
			if (changes.length > 20) console.log(c.dim(`  …共 ${changes.length} 个`));
			// 03 §6.3：进入用户分支必须显式确认；非 TTY 拒绝（可手工 git commit）
			if (process.stdin.isTTY !== true) {
				console.error(c.yellow("非交互环境拒绝结算（03 §6.3 无旁路）；在 TTY 运行或手工 git commit"));
				return 4;
			}
			const ok = await confirm(
				`提交到当前分支？（ponda(${(flags.get("task") as string | undefined)?.slice(0, 8) ?? target.sessionId.slice(0, 8)}): ${summary}）`,
			);
			if (!ok) {
				console.log(c.dim("已取消（变更保留在工作区与快照链）"));
				return 4;
			}
			const taskId = typeof flags.get("task") === "string" ? (flags.get("task") as string) : undefined;
			const r = tracker.settle(target.sessionId, summary, { taskId });
			if (!r.ok) {
				console.error(`结算失败：${r.detail}`);
				return 1;
			}
			// wiki 增量更新（08 §3.1：任务结算后按 git diff 触及 scope 复验）
			if (existsSync(join(target.workspace, ".wiki"))) {
				try {
					const wiki = refreshWiki(target.workspace, { supplier: () => null });
					if (wiki.reviewed.length + wiki.refreshed.length > 0) {
						console.log(
							c.dim(`  wiki 复验：${wiki.reviewed.length} 页确认现状 / ${wiki.refreshed.length} 页更新`),
						);
					}
				} catch {
					// wiki 复验失败不阻塞结算
				}
			}
			emitCliEvent(home, process.env.PONDA_ACTIVE_ENV ?? "default", "sandbox.settle", {
				activityId: target.sessionId.slice(0, 8),
				mode: "inplace",
				files: { nModified: changes.length, nTotal: changes.length },
				outcome: "apply",
			});
			console.log(c.green("✓"), r.detail);
			return 0;
		}

		case "rollback": {
			// 回滚（03 §6.2）：--turn <n> | --baseline；确认后 reset --hard 到快照
			const tracker = loadTracker(home, flags);
			const acts = tracker.list().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
			const prefix = typeof flags.get("session") === "string" ? (flags.get("session") as string) : undefined;
			const target = prefix !== undefined ? acts.find((a) => a.sessionId.startsWith(prefix)) : acts[0];
			if (target === undefined) {
				console.error("无沙箱活动");
				return 2;
			}
			const baseline = flags.get("baseline") === true;
			const turnStr = typeof flags.get("turn") === "string" ? (flags.get("turn") as string) : args[0];
			if (!baseline && turnStr === undefined) {
				console.error("用法：ponda sandbox rollback <turn> [--session <前缀>] | --baseline");
				return 1;
			}
			console.log(
				c.yellow(`将 reset --hard 到 ${baseline ? "baseline" : `turn ${turnStr}`}（未提交变更将丢失，快照链保留）`),
			);
			if (process.stdin.isTTY !== true) {
				console.error(c.yellow("非交互环境拒绝回滚；在 TTY 运行或手工 git checkout <快照>"));
				return 4;
			}
			const ok = await confirm("确认回滚？");
			if (!ok) {
				console.log(c.dim("已取消"));
				return 4;
			}
			const r = tracker.rollbackTo(target.sessionId, {
				baseline,
				turn: turnStr !== undefined ? Number.parseInt(turnStr, 10) : undefined,
			});
			if (!r.ok) {
				console.error(`回滚失败：${r.detail}`);
				return 1;
			}
			emitCliEvent(home, process.env.PONDA_ACTIVE_ENV ?? "default", "sandbox.settle", {
				activityId: target.sessionId.slice(0, 8),
				mode: "inplace",
				outcome: "discard",
			});
			console.log(c.green("✓"), r.detail);
			return 0;
		}

		default:
			console.error(
				`可用动作：list / settle <id> --apply|--discard / clean [--dry-run] / create <path>... / backend / snapshots [前缀] / commit <摘要> / rollback <turn>|--baseline`,
			);
			return 1;
	}
}

export { mapPath } from "../../../sandbox/src/index.ts";

function loadTracker(home: string, flags: Map<string, string | boolean>): InplaceSandboxTracker {
	const env =
		typeof flags.get("env") === "string" ? (flags.get("env") as string) : (process.env.PONDA_ACTIVE_ENV ?? "default");
	return new InplaceSandboxTracker(join(paths.env(home, env), "state", "sandbox-activities.json"));
}

function confirm(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${question} [y/N] `, (a) => {
			rl.close();
			resolve(a.trim().toLowerCase() === "y" || a.trim().toLowerCase() === "yes");
		});
	});
}
