/**
 * 临时工作区（模式 C）：工作区外文件操作的副本沙箱（design: 03 §4）。
 * 原文件只读不动；结算 apply 时备份原文件为 <path>.ponda-bak-<ts> 再写回；永不自动删除原文件。
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { paths, pondaHome } from "../../core/src/paths.ts";

export interface TempSandbox {
	id: string;
	dir: string;
	createdAt: string;
	/** realPath（绝对） → 沙箱内路径（绝对） */
	mappings: Record<string, string>;
}

function sandboxIndexFile(dir: string): string {
	return join(dir, "sandbox.json");
}

export function loadSandbox(dir: string): TempSandbox | null {
	const f = sandboxIndexFile(dir);
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf8")) as TempSandbox;
}

export function listSandboxes(home = pondaHome()): TempSandbox[] {
	const root = paths.sandboxes(home);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => loadSandbox(join(root, e.name)))
		.filter((s): s is TempSandbox => s !== null)
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 创建沙箱并拷入目标文件（不存在的新文件登记为 pending-create） */
export function createSandbox(sessionId: string, seq: number, targets: string[], home = pondaHome()): TempSandbox {
	const id = `${sessionId.slice(0, 8)}-${seq}`;
	const dir = join(paths.sandboxes(home), id);
	if (existsSync(dir)) throw new Error(`sandbox already exists: ${id}`);
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(dir, "repo"), { recursive: true });

	const mappings: Record<string, string> = {};
	for (const target of targets) {
		const virt = join(dir, "repo", target.replace(/^\/+/, ""));
		mkdirSync(dirname(virt), { recursive: true });
		if (existsSync(target) && statSync(target).isFile()) {
			copyFileSync(target, virt);
		} else {
			writeFileSync(virt, "", "utf8"); // 新文件占位（原路径不存在）
		}
		mappings[target] = virt;
	}
	const sb: TempSandbox = { id, dir, createdAt: new Date().toISOString(), mappings };
	writeFileSync(sandboxIndexFile(dir), JSON.stringify(sb, null, "\t"), "utf8");
	return sb;
}

export interface SettleFileReport {
	realPath: string;
	changed: boolean;
	created: boolean;
	applied: boolean;
}

export interface SettleResult {
	outcome: "apply" | "discard";
	files: SettleFileReport[];
	/** 原文件永不被删除；apply 前备份路径列表 */
	backups: string[];
}

/** 结算：apply = 备份原文件后写回沙箱副本；discard = 沙箱移入 .trash 保留 7 天 */
export function settleSandbox(
	sb: TempSandbox,
	outcome: "apply" | "discard",
	opts: { home?: string; apply?: string[] } = {},
): SettleResult {
	const home = opts.home ?? pondaHome();
	const files: SettleFileReport[] = [];
	const backups: string[] = [];
	const ts = new Date().toISOString().replace(/[:.]/g, "-");

	if (outcome === "apply") {
		for (const [realPath, virt] of Object.entries(sb.mappings)) {
			if (opts.apply && !opts.apply.includes(realPath)) continue;
			const original = existsSync(realPath) ? readFileSync(realPath, "utf8") : null;
			const modified = readFileSync(virt, "utf8");
			const changed = original !== modified;
			const created = original === null;
			let applied = false;
			if (changed) {
				if (original !== null) {
					const backup = `${realPath}.ponda-bak-${ts}`;
					copyFileSync(realPath, backup); // 永不自动删除原文件（design: 03 §4.1）
					backups.push(backup);
				} else {
					mkdirSync(dirname(realPath), { recursive: true });
				}
				writeFileSync(realPath, modified, "utf8");
				applied = true;
			}
			files.push({ realPath, changed, created, applied });
		}
	}

	// 沙箱本体：apply 后归档到 .trash；discard 直接归档（7 天保留语义）
	const trashDir = join(paths.trash(home), "sandboxes");
	mkdirSync(trashDir, { recursive: true });
	try {
		renameSync(sb.dir, join(trashDir, `${sb.id}-${ts}`));
	} catch {
		rmSync(sb.dir, { recursive: true, force: true }); // 跨设备 rename 失败的兜底
	}

	return { outcome, files, backups };
}

/** 沙箱内路径 → 真实路径映射查询（agent 读写重定向用） */
export function mapPath(sb: TempSandbox, target: string): string | null {
	if (sb.mappings[target]) return sb.mappings[target];
	// 目录级映射（目标在某已映射文件的同目录树下）
	for (const [real, virt] of Object.entries(sb.mappings)) {
		if (target.startsWith(`${dirname(real)}/`)) {
			return join(dirname(virt), relative(dirname(real), target));
		}
	}
	return null;
}
