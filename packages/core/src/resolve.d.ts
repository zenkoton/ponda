/**
 * 继承链解析：defaults 层 → 根环境 → ... → 目标环境（design: 01-environment.md §3）。
 * 物化（materialize）把合并后的差量补全为 EnvManifest 完整形态。
 */
import { type EnvManifest, type EnvManifestInput } from "./types.ts";
/** 内置默认层（= ponda init 创建的 default 环境内容，design: 01 §2.3） */
export declare const DEFAULTS_INPUT: EnvManifestInput;
export declare class EnvNotFoundError extends Error {
	constructor(name: string);
}
export declare class EnvCycleError extends Error {
	constructor(chain: string[]);
}
export interface ResolvedEnv {
	/** 自根向下的继承链（不含内置 defaults 层），如 ["default", "web-dev"] */
	chain: string[];
	/** 合并后的差量（未物化） */
	input: EnvManifestInput;
	/** 物化完整形态（渲染器消费） */
	effective: EnvManifest;
}
export type ManifestReader = (name: string) => EnvManifestInput | null;
/**
 * 解析环境的生效配置。
 * - base 缺省为 "default"；"default" 环境不存在时以内置 DEFAULTS_INPUT 收尾
 * - 环境链检测成环抛 EnvCycleError；中间环境缺失抛 EnvNotFoundError
 */
export declare function resolveEnv(read: ManifestReader, name: string): ResolvedEnv;
/** 物化：差量 → 完整 EnvManifest（幂等，不修改输入） */
export declare function materialize(
	input: EnvManifestInput,
	meta: {
		name: string;
		base?: string;
		createdAt: string;
		updatedAt: string;
	},
): EnvManifest;
//# sourceMappingURL=resolve.d.ts.map
