/**
 * manifest 与环境名校验（design: 01-environment.md §4.1）。
 * 零依赖、手写结构校验，返回错误列表（空数组 = 通过）。
 */
import { type EnvManifestInput, type ResourceSelector } from "./types.ts";
/** 与一级子命令冲突的保留字（design: 01 §4.1） */
export declare const RESERVED_WORDS: readonly string[];
export declare function validateEnvName(name: string): string[];
/** 校验差量 manifest（partial 语义：缺省字段不检查）。返回错误列表。 */
export declare function validateManifestInput(input: EnvManifestInput): string[];
/** 选择器的名字（含 "!" 排除前缀则原样返回） */
export declare function selectorName(s: ResourceSelector): string;
/** 是否为排除选择器（"!name" 形态） */
export declare function isExclusionSelector(s: ResourceSelector): boolean;
/** 排除选择器去掉 "!" 后的目标名 */
export declare function exclusionTarget(s: ResourceSelector): string;
//# sourceMappingURL=validate.d.ts.map
