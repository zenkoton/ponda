import { type ResolvedEnv } from "./resolve.ts";
import type { EnvManifestInput, EnvSummary, PondaState } from "./types.ts";
export declare class ValidationError extends Error {
	constructor(message: string);
}
export interface CreateEnvOptions {
	name: string;
	base?: string;
	description?: string;
	systemPrompt?: string;
	/** 差量字段（skills/extensions/...），仅写入用户显式声明的部分 */
	patch?: EnvManifestInput;
}
export declare class EnvStore {
	readonly home: string;
	constructor(home: string);
	static defaultHome(): string;
	exists(name: string): boolean;
	names(): string[];
	readManifest(name: string): EnvManifestInput | null;
	private writeManifest;
	resolve(name: string): ResolvedEnv;
	/** 公开受控写入口（resources 等模块经校验后调用；input.name 决定目标环境） */
	saveManifest(input: EnvManifestInput): void;
	/** 重渲染指定环境 */
	rerender(name: string): void;
	readState(): PondaState;
	private writeState;
	create(opts: CreateEnvOptions): ResolvedEnv;
	remove(
		name: string,
		opts?: {
			force?: boolean;
		},
	): void;
	rename(oldName: string, newName: string): void;
	activate(name: string): ResolvedEnv;
	deactivate(): void;
	/** 记录工作区本地绑定（state.json perWorkspace；design: 01 §7.2） */
	bindWorkspace(wsRoot: string, env: string): void;
	unbindWorkspace(wsRoot: string): void;
	list(): EnvSummary[];
	diff(
		a: string,
		b: string,
	): {
		path: string;
		a?: unknown;
		b?: unknown;
	}[];
	exportEnv(name: string, outDir: string): void;
	importEnv(
		dir: string,
		opts?: {
			name?: string;
		},
	): ResolvedEnv;
	doctor(): {
		level: "error" | "warn" | "info";
		message: string;
	}[];
}
//# sourceMappingURL=store.d.ts.map
