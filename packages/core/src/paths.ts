/**
 * 目录约定（design: 00-overview.md §4 / 01 §2.2）。
 * PONDA_HOME 环境变量可覆盖 ~/.ponda。
 */

import { homedir } from "node:os";
import { join } from "node:path";

export function pondaHome(): string {
	return process.env.PONDA_HOME ? join(process.env.PONDA_HOME) : join(homedir(), ".ponda");
}

export const paths = {
	state: (home: string) => join(home, "state.json"),
	globalConfig: (home: string) => join(home, "ponda.json"),
	envs: (home: string) => join(home, "envs"),
	env: (home: string, name: string) => join(home, "envs", name),
	envManifest: (home: string, name: string) => join(home, "envs", name, "manifest.json"),
	envActivatedAt: (home: string, name: string) => join(home, "envs", name, ".activated-at"),
	resources: (home: string) => join(home, "resources"),
	/** resources/<kind>s/<name> —— kind 传复数形式（skills/extensions/...） */
	resource: (home: string, kindPlural: string, name: string) => join(home, "resources", kindPlural, name),
	sandboxes: (home: string) => join(home, "sandboxes"),
	daemon: (home: string) => join(home, "daemon"),
	telemetry: (home: string) => join(home, "telemetry"),
	trash: (home: string) => join(home, ".trash"),
	shellInteg: (home: string, shell: string) => join(home, "shell", `${shell}.sh`),
};

/** 环境目录内的固定子目录（渲染时确保存在） */
export const ENV_SUBDIRS = ["skills", "extensions", "themes", "prompts", "memory", "sessions"] as const;

/** 渲染产物文件名（manifest → pi 消费文件） */
export const RENDERED_FILES = [
	"settings.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"models.json",
	"mcp.json",
	"keybindings.json",
] as const;
