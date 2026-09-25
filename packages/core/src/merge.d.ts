/**
 * 环境继承合并引擎 —— 逐字段策略表（design: 01-environment.md §3.1）。
 *
 * effective(env) = merge(effective(base(env)), env.manifest)
 * 深合并统一定义：对象递归；数组按字段既定策略；null = 删除目标键。
 */
import type {
	CommandTool,
	CustomToolSpec,
	EnvManifestInput,
	MemoryPolicy,
	Privilege,
	ResourceSelector,
} from "./types.ts";
/**
 * 选择器列表并集合并（skills/extensions/themes）：
 * - 子环境 "!name" 排除父环境同名项
 * - 子环境非排除项覆盖父环境同名项（保持父列表位置），新项追加到尾部
 */
export declare function mergeSelectors(base: ResourceSelector[], child: ResourceSelector[]): ResourceSelector[];
/**
 * CommandTool 列表按 name 合并：子覆盖父（原位）、新项追加；
 * ToolDeletion（{name, delete:true}）删除父环境同名项。
 */
export declare function mergeCommandTools(base: CustomToolSpec[], child: CustomToolSpec[]): CommandTool[];
/** 可空记录合并：child 值 null 删除键，否则覆盖 */
export declare function mergeNullableRecord<T>(
	base: Record<string, T>,
	child: Record<string, T | null>,
): Record<string, T>;
/** MemoryPolicy 等宽松对象：浅合并（child 键覆盖，null 删除） */
export declare function mergeMemory(base?: MemoryPolicy, child?: MemoryPolicy): MemoryPolicy | undefined;
/** privileges.privileges：集合并集（保持 base 顺序，新项追加） */
export declare function unionPrivileges(base: Privilege[], child: Privilege[]): Privilege[];
/**
 * 主合并入口：base（父环境 effective 差量）⊕ child（本环境 manifest 差量）。
 * name/base/createdAt/updatedAt 不参与合并（子环境自身的值生效）。
 */
export declare function mergeEnv(base: EnvManifestInput | undefined, child: EnvManifestInput): EnvManifestInput;
//# sourceMappingURL=merge.d.ts.map
