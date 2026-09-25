/**
 * agent swarm 运行时（design: 05-runtime.md §6；M8）。
 * - SwarmCell：每 cell 独立会话（SessionManager）+ own-worktree 写隔离（03 §5.3）
 * - 信箱：定向消息（send_message/read_messages 语义；收件作为该 cell 的下一条输入）
 * - 熔断：并发 ≤ maxParallel；累计费用 ≥ maxSwarmCostUsd 拒绝新 spawn（暂停并询问语义）
 * - 失败自动重试 1 次（新会话重放 brief）；done 后清理 worktree 并递交结果摘要
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { SwarmCellInfo, SwarmMessage, SwarmStatus, SwarmWorkspaceMode } from "../../rpc/src/protocol.ts";
import { addWorktree, isGitRepo } from "../../sandbox/src/gitops.ts";
import type { AgentLoop } from "./agent-loop.ts";
import type { SessionManager } from "./sessions.ts";

export class SwarmError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SwarmError";
	}
}

interface CellRecord {
	info: SwarmCellInfo;
	worktreeCleaned: boolean;
}

export interface SpawnSpec {
	role: string;
	brief: string;
	workspaceMode?: SwarmWorkspaceMode;
	workspace?: string | null;
}

export interface SwarmRuntimeOptions {
	sessions: SessionManager;
	/** 每 cell 新建循环（测试注入失败/脚本循环） */
	loopFor: (cell: SwarmCellInfo) => AgentLoop;
	maxParallel?: number; // 默认 3（design: runtime.maxParallelSubagents）
	maxSwarmCostUsd?: number; // 默认 5（design: 05 §6.2 费用熔断）
}

export type SwarmEventSink = (event: { kind: string; cellId?: string; [k: string]: unknown }) => void;

export const MAIN_CELL_ID = "main";

export class SwarmRuntime {
	private readonly cells = new Map<string, CellRecord>();
	private readonly mailboxes = new Map<string, SwarmMessage[]>();
	private readonly loops = new Map<string, AgentLoop>();
	private nextMsgId = 1;
	private sink: SwarmEventSink | null = null;
	private readonly opts: SwarmRuntimeOptions;

	constructor(opts: SwarmRuntimeOptions) {
		this.opts = opts;
		opts.sessions.onIdle = (sessionId) => this.onSessionIdle(sessionId);
		// 主 agent 信箱（插话目标；TUI 切到 cell 后发送即入该 cell 信箱）
		this.mailboxes.set(MAIN_CELL_ID, []);
	}

	setEventSink(sink: SwarmEventSink): void {
		this.sink = sink;
	}

	private emit(kind: string, extra: Record<string, unknown> = {}): void {
		this.sink?.({ kind, ...extra });
	}

	private breakerCheck(): void {
		const active = [...this.cells.values()].filter(
			(c) => c.info.status === "running" || c.info.status === "spawning" || c.info.status === "retrying",
		).length;
		if (active >= (this.opts.maxParallel ?? 3)) {
			throw new SwarmError(`并发熔断：活跃 cell ${active} ≥ maxParallel ${this.opts.maxParallel ?? 3}`);
		}
		const cost = this.status().totals.costUsd;
		if (cost >= (this.opts.maxSwarmCostUsd ?? 5)) {
			throw new SwarmError(
				`费用熔断：累计 $${cost.toFixed(3)} ≥ maxSwarmCostUsd ${this.opts.maxSwarmCostUsd ?? 5}，暂停 spawning`,
			);
		}
	}

	/** spawn_subagent：创建 cell + 独立会话（+ own-worktree）并投递 brief */
	spawn(spec: SpawnSpec): SwarmCellInfo {
		this.breakerCheck();
		const cellId = `cell-${randomUUID().slice(0, 8)}`;
		const mode: SwarmWorkspaceMode = spec.workspaceMode ?? "own-worktree";
		const ws = spec.workspace ?? null;

		let workspace = ws;
		let worktreeDir: string | null = null;
		if (mode === "own-worktree" && ws !== null) {
			if (isGitRepo(ws)) {
				const wt = addWorktree(ws, `swarm-${cellId}`);
				if (!wt.ok) throw new SwarmError(`worktree 创建失败：${wt.detail}`);
				worktreeDir = wt.dir ?? null;
				workspace = worktreeDir;
			} else {
				// 非 git 工作区：降级 shared-worktree（记入 info 供诊断）
				workspace = ws;
			}
		} else if (mode === "shared-worktree") {
			workspace = ws;
		}

		const created = this.opts.sessions.new({ workspace });
		const info: SwarmCellInfo = {
			cellId,
			role: spec.role,
			brief: spec.brief,
			sessionId: created.sessionId,
			status: "running",
			workspaceMode: mode,
			workspace,
			worktreeDir,
			tokens: { input: 0, output: 0 },
			costUsd: 0,
			retries: 0,
			unread: 0,
			lastResult: null,
			lastError: null,
		};
		this.cells.set(cellId, { info, worktreeCleaned: false });
		this.loops.set(cellId, this.opts.loopFor(info));
		this.mailboxes.set(cellId, []);
		this.opts.sessions.setLoop(created.sessionId, this.loops.get(cellId) as AgentLoop);
		this.emit("spawned", { cellId, role: spec.role });

		// 投递 brief（经会话队列异步执行）
		this.opts.sessions.send(created.sessionId, spec.brief);
		return { ...info };
	}

	status(): SwarmStatus {
		const cells = [...this.cells.values()].map((c) => {
			// 会话费用回填
			const row = this.opts.sessions.list().find((s) => s.sessionId === c.info.sessionId);
			if (row !== undefined) {
				c.info.tokens = { ...row.tokens };
				c.info.costUsd = row.costUsd;
			}
			c.info.unread = (this.mailboxes.get(c.info.cellId) ?? []).filter((m) => !m.consumed).length;
			return { ...c.info };
		});
		const totals = {
			costUsd: Math.round(cells.reduce((a, c) => a + c.costUsd, 0) * 1e6) / 1e6,
			active: cells.filter((c) => c.status === "running" || c.status === "spawning" || c.status === "retrying")
				.length,
			done: cells.filter((c) => c.status === "done").length,
		};
		return {
			cells,
			totals,
			maxParallel: this.opts.maxParallel ?? 3,
			maxSwarmCostUsd: this.opts.maxSwarmCostUsd ?? 5,
		};
	}

	/** send_message：定向信箱（cell 在跑则顺带投递为其下一条会话输入） */
	send(from: string, to: string, payload: string): SwarmMessage {
		if (to !== MAIN_CELL_ID && !this.cells.has(to)) {
			throw new SwarmError(`cell not found: ${to}`);
		}
		const msg: SwarmMessage = {
			id: `m${this.nextMsgId++}`,
			from,
			to,
			payload,
			at: new Date().toISOString(),
			consumed: false,
		};
		this.mailboxes.get(to)?.push(msg);
		if (to !== MAIN_CELL_ID) {
			const cell = this.cells.get(to);
			if (cell !== undefined && (cell.info.status === "running" || cell.info.status === "retrying")) {
				this.opts.sessions.send(cell.info.sessionId, `[message from ${from}] ${payload}`);
			}
		}
		this.emit("message", { from, to, messageId: msg.id });
		return msg;
	}

	/** read_messages：取信箱（默认收件即标记消费） */
	read(cellId: string, opts: { consume?: boolean } = {}): SwarmMessage[] {
		const box = this.mailboxes.get(cellId);
		if (box === undefined) throw new SwarmError(`cell not found: ${cellId}`);
		const out = [...box];
		if (opts.consume !== false) {
			for (const m of box) m.consumed = true;
		}
		return out;
	}

	cancel(cellId: string): SwarmCellInfo {
		const rec = this.cells.get(cellId);
		if (rec === undefined) throw new SwarmError(`cell not found: ${cellId}`);
		rec.info.status = "cancelled";
		this.cleanupWorktree(rec);
		this.emit("cancelled", { cellId });
		return { ...rec.info };
	}

	private onSessionIdle(sessionId: string): void {
		const rec = [...this.cells.values()].find((c) => c.info.sessionId === sessionId);
		if (rec === undefined) return;
		if (rec.info.status === "cancelled" || rec.info.status === "done") return;

		// 结果摘要 = 会话最后一条 assistant 输出
		const lastResult = this.lastAssistantText(sessionId);
		const st = this.status();
		const row = st.cells.find((c) => c.cellId === rec.info.cellId);

		// 失败重试（≤1 次，design: 05 §6.2）
		if (lastResult === null && row !== undefined && rec.info.retries < 1) {
			rec.info.retries++;
			rec.info.status = "retrying";
			this.emit("retrying", { cellId: rec.info.cellId, retries: rec.info.retries });
			const created = this.opts.sessions.new({ workspace: rec.info.workspace });
			rec.info.sessionId = created.sessionId;
			this.loops.set(rec.info.cellId, this.opts.loopFor({ ...rec.info }));
			this.opts.sessions.setLoop(created.sessionId, this.loops.get(rec.info.cellId) as AgentLoop);
			this.opts.sessions.send(created.sessionId, rec.info.brief);
			return;
		}
		if (lastResult === null) {
			rec.info.status = "failed";
			rec.info.lastError = "no assistant output";
			this.cleanupWorktree(rec);
			this.emit("failed", { cellId: rec.info.cellId });
			return;
		}
		rec.info.lastResult = lastResult;
		rec.info.status = "done";
		this.cleanupWorktree(rec);
		this.emit("done", { cellId: rec.info.cellId });
	}

	private lastAssistantText(sessionId: string): string | null {
		const s = this.opts.sessions.get(sessionId);
		if (s === null) return null;
		const text = s.file;
		try {
			const lines = readFileSync(text, "utf8").split("\n").filter(Boolean);
			for (let i = lines.length - 1; i >= 0; i--) {
				const e = JSON.parse(lines[i] as string) as {
					type?: string;
					message?: { role?: string; content?: unknown };
				};
				if (e.type === "message" && e.message?.role === "assistant") {
					const c = e.message.content;
					if (typeof c === "string") return c;
					if (Array.isArray(c)) {
						const texts = c
							.filter(
								(b): b is { type: string; text: string } => typeof b === "object" && b !== null && "text" in b,
							)
							.map((b) => b.text);
						if (texts.length > 0) return texts.join("\n");
					}
				}
			}
		} catch {
			// 读失败按无输出处理
		}
		return null;
	}

	private cleanupWorktree(rec: CellRecord): void {
		if (rec.worktreeCleaned || rec.info.worktreeDir === null || rec.info.workspace === null) return;
		rec.worktreeCleaned = true;
		// worktree 目录位于原工作区 .ponda/worktrees/（03 §5.3），从其父工作区移除
		const ws = rec.info.workspace;
		if (existsSync(ws)) {
			void removeWorktreeByPath(ws, rec.info.worktreeDir);
		}
	}
}

function removeWorktreeByPath(ws: string, dir: string): { ok: boolean; detail: string } {
	// removeWorktree 按 wtId 定位；此处直接用 git 命令移除指定目录
	const r = spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: ws, encoding: "utf8" });
	return { ok: r.status === 0, detail: (r.stderr ?? "").trim() };
}
