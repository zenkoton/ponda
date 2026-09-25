import type { EnvStore } from "./store.ts";
export interface HistoryEntry {
	sessionId: string;
	env: string;
	workspace: string | null;
	title: string;
	lastActiveAt: string;
	entryCount: number;
	tokens: {
		input: number;
		output: number;
	};
	cost: number;
	status: "ended";
	file: string;
}
/** 解析单个 pi 会话 JSONL（容错：坏行跳过；标题取首条用户消息） */
export declare function parseSessionFile(file: string): Omit<HistoryEntry, "env" | "file"> | null;
export declare class HistoryIndex {
	private readonly store;
	constructor(store: EnvStore);
	scan(): HistoryEntry[];
	list(opts?: { env?: string; workspace?: string; keyword?: string }): HistoryEntry[];
	remove(sessionId: string): HistoryEntry;
	/** attach 所需信息：环境 + 会话文件路径（由 CLI 用对应环境恢复） */
	attachInfo(sessionId: string): {
		env: string;
		file: string;
	};
}
//# sourceMappingURL=history.d.ts.map
