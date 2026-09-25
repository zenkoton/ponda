/**
 * 工作区级配置与环境解析（design: 01-environment.md §7）。
 * 优先级：perWorkspace（本地绑定） > .ponda/ponda.json#bind（项目推荐） > activeEnv（全局） > default。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PondaState, WorkspacePondaConfig } from "./types.ts";

export const WORKSPACE_CONFIG_DIR = ".ponda";

/** 自 cwd 向上寻找工作区根（含 .ponda/ 或 .git/ 的最近目录；都没有则 cwd 本身） */
export function findWorkspaceRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, WORKSPACE_CONFIG_DIR)) || existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) return cwd;
		dir = parent;
	}
}

export function readWorkspaceConfig(wsRoot: string): WorkspacePondaConfig | null {
	const file = join(wsRoot, WORKSPACE_CONFIG_DIR, "ponda.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as WorkspacePondaConfig;
	} catch {
		return null;
	}
}

export type EnvResolutionSource = "perWorkspace" | "bind" | "active" | "default";

export interface EnvResolution {
	env: string;
	source: EnvResolutionSource;
	workspaceRoot: string | null;
	/** 工作区绑定与全局激活不一致（chpwd 钩子据此提示） */
	conflict: boolean;
}

/** 解析 cwd 应使用的环境（design: 01 §7.2 优先级） */
export function resolveEnvForWorkspace(cwd: string, state: PondaState): EnvResolution {
	const root = findWorkspaceRoot(cwd);
	const cfg = readWorkspaceConfig(root);
	const bind = cfg?.bind;

	if (state.perWorkspace) {
		const local = state.perWorkspace[root];
		if (local) {
			return { env: local, source: "perWorkspace", workspaceRoot: root, conflict: state.activeEnv !== local };
		}
	}
	if (bind) {
		return { env: bind, source: "bind", workspaceRoot: root, conflict: state.activeEnv !== bind };
	}
	if (state.activeEnv) {
		return { env: state.activeEnv, source: "active", workspaceRoot: root, conflict: false };
	}
	return { env: "default", source: "default", workspaceRoot: root, conflict: false };
}
