/**
 * SessionManager：daemon 内会话运行时（design: 05-runtime.md §5.1/§5.2）。
 * - 会话落盘为 pi 兼容 JSONL（header + message 树形条目），history 索引可直接消费
 * - attach/detach 是客户端概念：detach 后会话继续执行；attach 带游标重放错过的条目
 * - 事件（entry/status/error）只推给 attach 了该会话的连接
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/src/paths.ts";
import type { SessionEvent, SessionListItem } from "../../rpc/src/protocol.ts";
import type { AgentLoop, Usage } from "./agent-loop.ts";

export type SessionStatus = "live" | "ended" | "interrupted";

interface SessionRuntime {
	id: string;
	file: string;
	/** 会话级循环覆盖（swarm cell 各自的 AgentLoop，06 §6.1） */
	loop?: AgentLoop;
	workspace: string | null;
	status: SessionStatus;
	processing: boolean;
	attachedConns: Set<number>;
	tokens: { input: number; output: number };
	costUsd: number;
	entryCount: number;
	queue: string[];
}

export interface NewSessionOptions {
	workspace?: string | null;
}

export class SessionManager {
	private readonly sessions = new Map<string, SessionRuntime>();

	private readonly home: string;
	private readonly env: string;
	private readonly loop: AgentLoop;

	constructor(home: string, env: string, loop: AgentLoop) {
		this.home = home;
		this.env = env;
		this.loop = loop;
	}

	private dir(): string {
		return join(paths.env(this.home, this.env), "sessions");
	}

	new(opts: NewSessionOptions = {}): { sessionId: string; entryCount: number } {
		const id = randomUUID();
		const file = join(this.dir(), `${id}.jsonl`);
		mkdirSync(this.dir(), { recursive: true });
		const header = {
			type: "session",
			id,
			timestamp: new Date().toISOString(),
			cwd: opts.workspace ?? null,
			provider: "ponda",
			modelId: this.loop.name,
			thinkingLevel: "off",
		};
		appendFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
		this.sessions.set(id, {
			id,
			file,
			workspace: opts.workspace ?? null,
			status: "live",
			processing: false,
			attachedConns: new Set(),
			tokens: { input: 0, output: 0 },
			costUsd: 0,
			entryCount: 1,
			queue: [],
		});
		return { sessionId: id, entryCount: 1 };
	}

	get(id: string): SessionRuntime | null {
		return this.sessions.get(id) ?? null;
	}

	/** daemon 启动时登记历史会话（崩溃恢复/列表完整） */
	registerExisting(id: string, status: SessionStatus): void {
		const file = join(this.dir(), `${id}.jsonl`);
		if (!existsSync(file) || this.sessions.has(id)) return;
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		let workspace: string | null = null;
		const first = lines[0] !== undefined ? (JSON.parse(lines[0]) as { cwd?: string | null }) : null;
		workspace = first?.cwd ?? null;
		let tokens = { input: 0, output: 0 };
		let costUsd = 0;
		for (const line of lines) {
			try {
				const e = JSON.parse(line) as {
					message?: { usage?: { input?: number; output?: number; cost?: { total?: number } } };
				};
				if (e.message?.usage) {
					tokens = {
						input: tokens.input + (e.message.usage.input ?? 0),
						output: tokens.output + (e.message.usage.output ?? 0),
					};
					costUsd += e.message.usage.cost?.total ?? 0;
				}
			} catch {
				// 坏行跳过
			}
		}
		this.sessions.set(id, {
			id,
			file,
			workspace,
			status,
			processing: false,
			attachedConns: new Set(),
			tokens,
			costUsd: Math.round(costUsd * 1e6) / 1e6,
			entryCount: lines.length,
			queue: [],
		});
	}

	/** 持久化状态快照（崩溃恢复输入）：当前 live 的会话 id 列表 */
	liveIds(): string[] {
		return [...this.sessions.values()].filter((s) => s.status === "live").map((s) => s.id);
	}

	list(): SessionListItem[] {
		return [...this.sessions.values()]
			.map((s) => this.toListItem(s))
			.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
	}

	private toListItem(s: SessionRuntime): SessionListItem {
		const exposed: SessionListItem["status"] =
			s.status === "live" ? (s.attachedConns.size > 0 ? "running" : "detached") : s.status;
		return {
			sessionId: s.id,
			status: exposed,
			processing: s.processing,
			attached: s.attachedConns.size,
			tokens: { ...s.tokens },
			costUsd: s.costUsd,
			entryCount: s.entryCount,
			workspace: s.workspace,
		};
	}

	/** 磁盘上存在但未注册的历史会话：按需注册（interrupted 标记 → interrupted，否则 ended） */
	ensureRegistered(id: string): boolean {
		if (this.sessions.has(id)) return true;
		const file = join(this.dir(), `${id}.jsonl`);
		if (!existsSync(file)) return false;
		const status = readFileSync(file, "utf8").includes('"ponda.interrupted"') ? "interrupted" : "ended";
		this.registerExisting(id, status);
		return true;
	}

	attach(id: string, connId: number, cursor?: number): { replay: string[]; cursor: number; readOnly: boolean } {
		if (!this.ensureRegistered(id)) throw new Error(`session not found: ${id}`);
		const s = this.must(id);
		// ended/interrupted 会话允许只读 attach（历史查看）；live 会话完整交互
		if (s.status !== "live" && s.attachedConns.size > 0) {
			throw new Error(`session ${id} is ${s.status}, cannot attach`);
		}
		s.attachedConns.add(connId);
		const from = Math.max(0, cursor ?? 0);
		const lines = readFileSync(s.file, "utf8").split("\n").filter(Boolean);
		return { replay: lines.slice(from), cursor: lines.length, readOnly: s.status !== "live" };
	}

	detach(id: string, connId: number): void {
		const s = this.must(id);
		s.attachedConns.delete(connId);
	}

	/** 连接断开：清理其 attach（会话本体不受影响——后台存活语义） */
	dropConn(connId: number): void {
		for (const s of this.sessions.values()) s.attachedConns.delete(connId);
	}

	/** 会话级循环覆盖（swarm 用；须在 send 之前设置） */
	setLoop(id: string, loop: AgentLoop): void {
		const s = this.must(id);
		s.loop = loop;
	}

	send(id: string, text: string): void {
		const s = this.must(id);
		if (s.status !== "live") throw new Error(`session ${id} is ${s.status}, cannot send`);
		this.appendEntry(s, {
			type: "message",
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text }] },
		});
		s.queue.push(text);
		this.kick(s);
	}

	private kick(s: SessionRuntime): void {
		if (s.processing) return;
		s.processing = true;
		this.emit(s.id, { kind: "status", status: "live", processing: true });
		void this.drain(s);
	}

	private async drain(s: SessionRuntime): Promise<void> {
		try {
			for (;;) {
				const text = s.queue.shift();
				if (text === undefined) break;
				const result = await (s.loop ?? this.loop).process({ userText: text, entryCount: s.entryCount });
				this.addUsage(s, result.usage);
				this.appendEntry(s, {
					type: "message",
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: result.assistantText }],
						usage: {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: 0,
							cacheWrite: 0,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: result.usage.costUsd,
							},
						},
					},
				});
			}
		} catch (e) {
			this.emit(s.id, { kind: "error", message: e instanceof Error ? e.message : String(e) });
		} finally {
			s.processing = false;
			this.emit(s.id, { kind: "status", status: "live", processing: false });
			try {
				this.onIdle?.(s.id);
			} catch {
				// idle 观察者异常不影响会话循环
			}
		}
	}

	private addUsage(s: SessionRuntime, u: Usage): void {
		s.tokens = { input: s.tokens.input + u.input, output: s.tokens.output + u.output };
		s.costUsd = Math.round((s.costUsd + u.costUsd) * 1e6) / 1e6;
	}

	end(id: string): void {
		const s = this.must(id);
		if (s.status !== "live") return;
		s.queue = [];
		s.status = "ended";
		this.appendEntry(s, {
			type: "custom",
			id: `${s.id}-end`,
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: "ponda.ended",
		});
		this.emit(s.id, { kind: "status", status: "ended", processing: false });
	}

	markInterrupted(id: string): void {
		const s = this.sessions.get(id);
		if (s === undefined || s.status !== "live") return;
		s.status = "interrupted";
		appendFileSync(
			s.file,
			`${JSON.stringify({
				type: "custom",
				id: `${s.id}-interrupted`,
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "ponda.interrupted",
			})}\n`,
			"utf8",
		);
	}

	private appendEntry(s: SessionRuntime, entry: Record<string, unknown>): void {
		const line = JSON.stringify(entry);
		appendFileSync(s.file, `${line}\n`, "utf8");
		s.entryCount++;
		this.emit(s.id, { kind: "entry", cursor: s.entryCount, line });
	}

	private emit(sessionId: string, event: SessionEvent): void {
		this.onEvent?.(sessionId, event, (connId: number) => {
			const s = this.sessions.get(sessionId);
			return s?.attachedConns.has(connId) ?? false;
		});
	}

	/** 由 DaemonCore 注入：把事件广播给 attach 了该会话的连接 */
	onEvent: ((sessionId: string, event: SessionEvent, filter: (connId: number) => boolean) => void) | null = null;

	/** 队列排空（处理结束）回调（swarm 判定 cell 完成的依据） */
	onIdle: ((sessionId: string) => void) | null = null;

	private must(id: string): SessionRuntime {
		const s = this.sessions.get(id);
		if (s === undefined) throw new Error(`session not found: ${id}`);
		return s;
	}
}
