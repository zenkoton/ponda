/** `ponda sandbox`：临时工作区结算与清理（design: 03 §4/§8）。快照/回滚面向工作区 git，见 packages/sandbox。 */

import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import { createSandbox, detectBackend, listSandboxes, loadSandbox, settleSandbox } from "../../../sandbox/src/index.ts";
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

		default:
			console.error(
				`可用动作：list / settle <id> --apply|--discard / clean [--dry-run] / create <path>... / backend`,
			);
			return 1;
	}
}

export { mapPath } from "../../../sandbox/src/index.ts";
