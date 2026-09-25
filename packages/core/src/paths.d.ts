/**
 * 目录约定（design: 00-overview.md §4 / 01 §2.2）。
 * PONDA_HOME 环境变量可覆盖 ~/.ponda。
 */
export declare function pondaHome(): string;
export declare const paths: {
	state: (home: string) => string;
	globalConfig: (home: string) => string;
	envs: (home: string) => string;
	env: (home: string, name: string) => string;
	envManifest: (home: string, name: string) => string;
	envActivatedAt: (home: string, name: string) => string;
	resources: (home: string) => string;
	/** resources/<kind>s/<name> —— kind 传复数形式（skills/extensions/...） */
	resource: (home: string, kindPlural: string, name: string) => string;
	sandboxes: (home: string) => string;
	daemon: (home: string) => string;
	telemetry: (home: string) => string;
	trash: (home: string) => string;
	shellInteg: (home: string, shell: string) => string;
};
/** 环境目录内的固定子目录（渲染时确保存在） */
export declare const ENV_SUBDIRS: readonly ["skills", "extensions", "themes", "prompts", "memory", "sessions"];
/** 渲染产物文件名（manifest → pi 消费文件） */
export declare const RENDERED_FILES: readonly [
	"settings.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"models.json",
	"mcp.json",
	"keybindings.json",
];
//# sourceMappingURL=paths.d.ts.map
