/**
 * daemon 状态持久化（design: 05 §5.1"Task/Todo/Deliverable 快照落 .ponda/、
 * daemon 重启不丢"；06 §3 envelope 快照）。
 * 事实源：~/.ponda/envs/<env>/state/{tasks,todos}/<id>.json（写穿、启动时懒加载）；
 * 有工作区的任务额外把 envelope 双写 <workspace>/.ponda/state/<taskId>.json（06 §5 可见性）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 启动时加载目录内全部 JSON 状态文件（坏文件跳过） */
export function loadStateDir<T>(dir: string): Map<string, T> {
	const out = new Map<string, T>();
	if (!existsSync(dir)) return out;
	for (const f of readdirSync(dir)) {
		if (!f.endsWith(".json")) continue;
		try {
			out.set(f.slice(0, -".json".length), JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
		} catch {
			// 坏状态文件：跳过（doctor 语义）
		}
	}
	return out;
}

/** 写穿单个状态文件（临时文件 + rename 原子替换） */
export function persistState(dir: string, id: string, value: unknown): void {
	const path = join(dir, `${id}.json`);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.ponda-tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

/** 删除状态文件 */
export function removeState(dir: string, id: string): void {
	const f = join(dir, `${id}.json`);
	if (existsSync(f)) rmSync(f);
}
