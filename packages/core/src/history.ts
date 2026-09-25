/**
 * 跨环境会话索引（design: 02-resources.md §8）。
 * 解析各环境 sessions/*.jsonl（pi 会话格式：header + 树形条目），构建派生索引。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./paths.ts";
import type { EnvStore } from "./store.ts";

export interface HistoryEntry {
	sessionId: string;
	env: string;
	workspace: string | null;
	title: string;
	lastActiveAt: string;
	entryCount: number;
	tokens: { input: number; output: number };
	cost: number;
	status: "ended";
	file: string;
}

interface SessionHeader {
	type: "session";
	id?: string;
	cwd?: string;
	timestamp?: string;
}

/** 解析单个 pi 会话 JSONL（容错：坏行跳过；标题取首条用户消息） */
export function parseSessionFile(file: string): Omit<HistoryEntry, "env" | "file"> | null {
	let header: SessionHeader | null = null;
	let title = "";
	let lastActiveAt = "";
	let entryCount = 0;
	let input = 0;
	let output = 0;
	let cost = 0;

	const lines = readFileSync(file, "utf8").split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		entryCount++;
		if (e.type === "session" && header === null) {
			header = e as unknown as SessionHeader;
			continue;
		}
		if (typeof e.timestamp === "string") lastActiveAt = e.timestamp;
		if (e.type === "message") {
			const msg = e.message as { role?: string; content?: unknown; usage?: Record<string, unknown> } | undefined;
			if (!msg) continue;
			if (msg.role === "user" && title === "") {
				title = extractText(msg.content).slice(0, 60);
			}
			const usage = msg.usage as { input?: number; output?: number; cost?: { total?: number } } | undefined;
			if (usage) {
				input += usage.input ?? 0;
				output += usage.output ?? 0;
				cost += usage.cost?.total ?? 0;
			}
		}
	}

	if (lastActiveAt === "") {
		lastActiveAt = statSync(file).mtime.toISOString();
	}
	return {
		sessionId: header?.id ?? basename(file, ".jsonl"),
		workspace: header?.cwd ?? null,
		title: title || "(无用户消息)",
		lastActiveAt,
		entryCount,
		tokens: { input, output },
		cost: Math.round(cost * 1e6) / 1e6,
		status: "ended",
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (Array.isArray(content)) {
		return content
			.map((c) => (typeof c === "object" && c !== null && "text" in c ? String((c as { text: string }).text) : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}
	return "";
}

export class HistoryIndex {
	private readonly store: EnvStore;

	constructor(store: EnvStore) {
		this.store = store;
	}

	scan(): HistoryEntry[] {
		const out: HistoryEntry[] = [];
		for (const env of this.store.names()) {
			const dir = join(paths.env(this.store.home, env), "sessions");
			if (!existsSync(dir)) continue;
			for (const f of readdirSync(dir)) {
				if (!f.endsWith(".jsonl")) continue;
				const file = join(dir, f);
				try {
					const parsed = parseSessionFile(file);
					if (parsed) out.push({ ...parsed, env, file });
				} catch {
					// 坏文件跳过（doctor 可另行报告）
				}
			}
		}
		return out.sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : -1));
	}

	list(opts: { env?: string; workspace?: string; keyword?: string } = {}): HistoryEntry[] {
		let entries = this.scan();
		if (opts.env) entries = entries.filter((e) => e.env === opts.env);
		if (opts.workspace) {
			const ws = opts.workspace;
			entries = entries.filter(
				(e) => e.workspace !== null && (e.workspace === ws || e.workspace.startsWith(`${ws}/`)),
			);
		}
		if (opts.keyword) {
			// 全文检索：标题 + 文件内容（标题命中优先；无 rg 时 JS 扫描由 CLI 层处理）
			const kw = opts.keyword.toLowerCase();
			entries = entries.filter(
				(e) => e.title.toLowerCase().includes(kw) || readFileSync(e.file, "utf8").toLowerCase().includes(kw),
			);
		}
		return entries;
	}

	remove(sessionId: string): HistoryEntry {
		const all = this.scan();
		const hit = all.find((e) => e.sessionId === sessionId || basename(e.file, ".jsonl") === sessionId);
		if (!hit) throw new Error(`history not found: ${sessionId}`);
		rmSync(hit.file);
		return hit;
	}

	/** attach 所需信息：环境 + 会话文件路径（由 CLI 用对应环境恢复） */
	attachInfo(sessionId: string): { env: string; file: string } {
		const hit = this.scan().find((e) => e.sessionId === sessionId || basename(e.file, ".jsonl") === sessionId);
		if (!hit) throw new Error(`history not found: ${sessionId}`);
		return { env: hit.env, file: hit.file };
	}
}
