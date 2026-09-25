import type { EnvManifest } from "./types.ts";
export interface PlannedFile {
	/** 相对 env dir */
	path: string;
	content: string;
}
export interface PlannedSymlink {
	/** 相对 env dir（链接位置，如 skills/react） */
	path: string;
	/** 资源池目标的绝对路径 */
	target: string;
}
export interface RenderPlan {
	files: PlannedFile[];
	symlinks: PlannedSymlink[];
	/** 本轮不应存在、需要清理的旧渲染产物（相对路径） */
	removed: string[];
	warnings: string[];
}
export interface RenderResult extends RenderPlan {
	dir: string;
}
/** 纯函数：计算渲染计划（只做只读 existsSync 探测，不写盘） */
export declare function planRender(home: string, name: string, env: EnvManifest): RenderPlan;
/** 落盘执行（幂等）：确保目录、写文件、重建受管软链接、清理受管孤儿链接与被移除产物 */
export declare function applyRender(home: string, name: string, plan: RenderPlan): RenderResult;
export declare function renderEnv(home: string, name: string, env: EnvManifest): RenderResult;
//# sourceMappingURL=render.d.ts.map
