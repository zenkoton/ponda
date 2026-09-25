/**
 * 目录约定（design: 00-overview.md §4 / 01 §2.2）。
 * PONDA_HOME 环境变量可覆盖 ~/.ponda。
 */
import { homedir } from "node:os";
import { join } from "node:path";
export function pondaHome() {
    return process.env.PONDA_HOME ? join(process.env.PONDA_HOME) : join(homedir(), ".ponda");
}
export const paths = {
    state: (home) => join(home, "state.json"),
    globalConfig: (home) => join(home, "ponda.json"),
    envs: (home) => join(home, "envs"),
    env: (home, name) => join(home, "envs", name),
    envManifest: (home, name) => join(home, "envs", name, "manifest.json"),
    envActivatedAt: (home, name) => join(home, "envs", name, ".activated-at"),
    resources: (home) => join(home, "resources"),
    /** resources/<kind>s/<name> —— kind 传复数形式（skills/extensions/...） */
    resource: (home, kindPlural, name) => join(home, "resources", kindPlural, name),
    sandboxes: (home) => join(home, "sandboxes"),
    daemon: (home) => join(home, "daemon"),
    telemetry: (home) => join(home, "telemetry"),
    trash: (home) => join(home, ".trash"),
    shellInteg: (home, shell) => join(home, "shell", `${shell}.sh`),
};
/** 环境目录内的固定子目录（渲染时确保存在） */
export const ENV_SUBDIRS = ["skills", "extensions", "themes", "prompts", "memory", "sessions"];
/** 渲染产物文件名（manifest → pi 消费文件） */
export const RENDERED_FILES = [
    "settings.json",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
    "models.json",
    "mcp.json",
    "keybindings.json",
];
//# sourceMappingURL=paths.js.map