/**
 * DaemonCore：每环境一个的常驻进程核心（design: 05-runtime.md §5.1-§5.3）。
 * - RPC dispatch：session 与 permission、task、cost、daemon 各组方法
 * - 空闲自退出：idleMs 内无 RPC 活动、无会话处理中、无 attach → 优雅退出
 * - 崩溃恢复：启动时对比上次 state 的 liveSessions，未优雅结束的标记 interrupted
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../../agent/src/index.ts";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { createCodingTools } from "../../coding-agent/src/core/tools/index.ts";
import { paths } from "../../core/src/paths.ts";
import type { PermissionMode } from "../../core/src/types.ts";
import { rebuildMetrics } from "../../metrics/src/etl.ts";
import {
	type CostSnapshot,
	type DeliverableChange,
	type DeliverableSpec,
	Methods,
	Notifications,
	RpcErrorCode,
	type SessionEvent,
} from "../../rpc/src/protocol.ts";
import { type RpcConnection, RpcServer } from "../../rpc/src/server.ts";
import { type AgentLoop, EchoAgentLoop } from "./agent-loop.ts";
import { TaskRuntime } from "./goal.ts";
import { loadMcpTools, type McpLoadResult } from "./mcp.ts";
import * as piLoopModule from "./pi-loop.ts";
import { InplaceSandboxTracker } from "./sandbox-session.ts";
import { SessionManager } from "./sessions.ts";
import { MAIN_CELL_ID, SwarmRuntime } from "./swarm.ts";
import { DaemonTelemetry } from "./telemetry.ts";
import { TodoRuntime } from "./todo.ts";

interface DaemonStateFile {
	env: string;
	pid: number;
	startedAt: string;
	liveSessions: string[];
}

export interface PermissionRequestPending {
	requestId: string;
	privilege: "read" | "write" | "execute";
	reason: string;
	detail: { tool: string; targetPath?: string; command?: string; mode: "C" | "B" | "danger" };
}

export interface PermissionAnswer {
	approved: boolean;
	scope: "once" | "session" | "env-always";
}

export interface DaemonCoreOptions {
	home: string;
	env: string;
	idleMs?: number; // 默认 30 分钟
	loop?: AgentLoop;
	maxParallelSubagents?: number; // design: runtime.maxParallelSubagents（默认 3）
	maxSwarmCostUsd?: number; // design: 05 §6.2 费用熔断（默认 5）
	/** P4：真实 agent loop（设置后新会话经 pi-agent-core 驱动） */
	piModel?: { modelId: string; systemPrompt?: string; faux?: FauxProviderRegistration };
	/** 按会话构造循环（真实链路：每会话独立 Agent 上下文/工作区/守卫；优先于 piModel） */
	loopFor?: (core: DaemonCore, ctx: { sessionId: string; workspace: string | null }) => AgentLoop;
	/** 会话权限模式默认值（03 §7.3；TUI /mode 可逐会话切换） */
	defaultPermissionMode?: PermissionMode;
	/** 权限申请默认超时（超时视为拒绝，design: 03 §7.2） */
	permissionTimeoutMs?: number;
}

interface PendingPermission {
	resolve: (a: PermissionAnswer) => void;
	timer: ReturnType<typeof setTimeout>;
	/** 决策埋点回填 privilege（07 §2 permission.decision） */
	privilege: string;
}

export class DaemonCore {
	readonly sessions: SessionManager;
	readonly tasks: TaskRuntime;
	readonly swarm: SwarmRuntime;
	readonly server: RpcServer;
	readonly telemetry: DaemonTelemetry;
	readonly todos: TodoRuntime;
	/** inplace 沙箱活动（03 §5.2/§6：快照链/状态机/结算/回滚） */
	readonly sandboxTracker: InplaceSandboxTracker;
	/** per-env MCP servers（start() 加载；shutdown() 停止） */
	private mcp: McpLoadResult = { tools: [], clients: [], warnings: [] };

	get mcpTools(): AgentTool<any>[] {
		return this.mcp.tools;
	}

	get mcpWarnings(): string[] {
		return this.mcp.warnings;
	}
	private readonly startedAt = new Date().toISOString();
	private lastActivity = Date.now();
	private idleTimer: ReturnType<typeof setInterval> | null = null;
	private readonly pendingPermissions = new Map<string, PendingPermission>();
	private nextPermissionId = 1;
	private readonly sessionModes = new Map<string, PermissionMode>();
	private shuttingDown = false;
	/** 退出钩子（main.ts 里 process.exit；测试里改写） */
	onExit: ((code: number) => void) | null = null;

	private readonly opts: DaemonCoreOptions;

	constructor(opts: DaemonCoreOptions) {
		this.opts = opts;
		const loop: AgentLoop = opts.loop ?? this.defaultLoop(opts);
		this.sessions = new SessionManager(opts.home, opts.env, loop);
		if (opts.loopFor !== undefined) {
			this.sessions.loopFor = (ctx) => opts.loopFor?.(this, ctx) ?? loop;
		}
		// 状态持久化（05 §5.1）：任务/看板/沙箱活动快照落盘，daemon 重启不丢
		const stateDir = join(paths.env(opts.home, opts.env), "state");
		this.sandboxTracker = new InplaceSandboxTracker(join(stateDir, "sandbox-activities.json"));
		// piModel 路径同样按会话构造独立循环（上下文隔离 + 工具事件落会话流，04 §5.3）
		if (opts.loopFor === undefined && opts.piModel !== undefined) {
			const piModel = opts.piModel;
			this.sessions.loopFor = (ctx) =>
				new piLoopModule.PiAgentLoop({
					modelId: piModel.modelId,
					systemPrompt: piModel.systemPrompt,
					faux: piModel.faux,
					tools: [...createCodingTools(ctx.workspace ?? opts.home), ...this.mcpTools],
					sessionId: ctx.sessionId,
					onToolEvent: (e) => {
						this.appendToolEntry(ctx.sessionId, e);
						this.telemetry.emit(
							"tool.result",
							{ tool: e.name, ok: e.ok, durationMs: e.durationMs, argsDigest: e.argsDigest },
							{ sessionId: ctx.sessionId },
						);
					},
					onTurnEnd: () => {
						// 03 §5.2 模式 A 快照链：每轮变更落 ponda/snapshots/<session>
						const ws = ctx.workspace ?? opts.home;
						this.sandboxTracker.snapshotTurn(ctx.sessionId, ws);
					},
				});
		}
		this.tasks = new TaskRuntime({ stateDir: join(stateDir, "tasks") });
		this.tasks.setEventSink((taskId, event) => {
			this.server.broadcast(Notifications.taskEvents, { taskId, event });
			// 07 §2 埋点：phase 迁移 → task.lifecycle；校准运行 → deliverable.verify
			if (event.kind === "phase") {
				this.telemetry.emit("task.lifecycle", { phase: event.phase, replans: event.replans ?? null }, { taskId });
			} else if (event.kind === "resumed") {
				this.telemetry.emit("task.lifecycle", { phase: event.phase ?? "executing", resumed: true }, { taskId });
			} else if (event.kind === "verify") {
				this.telemetry.emit(
					"deliverable.verify",
					{
						deliverableId: event.deliverable,
						passed: event.passed === true,
						attempt: event.attempt ?? 1,
						detail: event.detail ?? "",
					},
					{ taskId },
				);
			}
		});
		this.swarm = new SwarmRuntime({
			sessions: this.sessions,
			loopFor: () => this.defaultLoop(opts),
			maxParallel: opts.maxParallelSubagents,
			maxSwarmCostUsd: opts.maxSwarmCostUsd,
			// 07 §2 swarm.cell 埋点（telemetry 在下方构造，闭包调用时已就绪）
			onTelemetry: (cell, transition) => {
				this.telemetry.emit(
					"swarm.cell",
					{
						cellId: cell.cellId,
						role: cell.role,
						transition,
						status: cell.status,
						tokens: cell.tokens,
						costUsd: cell.costUsd,
						retries: cell.retries,
					},
					{ sessionId: cell.sessionId },
				);
			},
		});
		this.swarm.setEventSink((event) => {
			this.server.broadcast(Notifications.swarmEvents, { event });
		});
		this.telemetry = new DaemonTelemetry({ home: opts.home, env: opts.env });
		this.todos = new TodoRuntime({ stateDir: join(stateDir, "todos") });
		this.server = new RpcServer((req, conn) => this.dispatch(req.method, req.params ?? {}, conn));
		this.server.onConnectionChange = (conn, up) => {
			if (!up) this.sessions.dropConn(conn.id);
		};
		this.sessions.onEvent = (sessionId, event: SessionEvent, filter) => {
			this.server.broadcast(Notifications.sessionEvents, { sessionId, event }, (conn) => filter(conn.id));
			if (event.kind === "error") {
				this.telemetry.emit(
					"error",
					{ source: "session", messageDigest: event.message.slice(0, 200) },
					{ sessionId },
				);
			}
			this.touch();
		};
		// 07 §2 埋点：message（tokens/costUsd）与 session.end
		this.sessions.onTurn = (sessionId, usage) => {
			this.telemetry.emit(
				"message",
				{ role: "assistant", tokens: { input: usage.input, output: usage.output }, costUsd: usage.costUsd },
				{ sessionId },
			);
		};
		this.sessions.onEnd = (sessionId, reason) => {
			this.telemetry.emit("session.end", { reason }, { sessionId });
		};
	}

	private stateFile(): string {
		return join(paths.daemon(this.opts.home), `${this.opts.env}.state.json`);
	}

	socketPath(): string {
		return join(paths.daemon(this.opts.home), `${this.opts.env}.sock`);
	}

	async start(): Promise<void> {
		mkdirSync(paths.daemon(this.opts.home), { recursive: true });
		// per-env MCP：加载 mcp.json 声明的 servers，工具注入会话工具面（02 §4）
		this.mcp = await loadMcpTools(this.opts.home, this.opts.env);
		this.recoverPreviousState();
		await this.server.listen(this.socketPath());
		this.writeState();
		this.idleTimer = setInterval(() => this.checkIdle(), 1000);
	}

	/** 崩溃恢复：上次 daemon 的 liveSessions 未优雅结束 → interrupted（design: 05 §5.2） */
	private recoverPreviousState(): void {
		const f = this.stateFile();
		if (!existsSync(f)) return;
		try {
			const prev = JSON.parse(readFileSync(f, "utf8")) as DaemonStateFile;
			for (const id of prev.liveSessions ?? []) {
				const file = join(paths.env(this.opts.home, this.opts.env), "sessions", `${id}.jsonl`);
				if (!existsSync(file)) continue;
				const text = readFileSync(file, "utf8");
				if (text.includes('"ponda.ended"')) {
					this.sessions.registerExisting(id, "ended");
				} else {
					this.sessions.registerExisting(id, "interrupted");
					if (!text.includes('"ponda.interrupted"')) {
						appendFileSync(
							file,
							`${JSON.stringify({
								type: "custom",
								id: `${id}-interrupted`,
								parentId: null,
								timestamp: new Date().toISOString(),
								customType: "ponda.interrupted",
							})}\n`,
							"utf8",
						);
					}
				}
			}
		} catch {
			// 坏状态文件：跳过恢复
		}
	}

	private writeState(): void {
		const st: DaemonStateFile = {
			env: this.opts.env,
			pid: process.pid,
			startedAt: this.startedAt,
			liveSessions: this.sessions.liveIds(),
		};
		writeFileSync(this.stateFile(), JSON.stringify(st, null, "\t"), "utf8");
	}

	private touch(): void {
		this.lastActivity = Date.now();
		this.writeState();
	}

	private busy(): boolean {
		return this.sessions.list().some((s) => s.processing) || this.server.connections.length > 0;
	}

	private checkIdle(): void {
		const idleMs = this.opts.idleMs ?? 30 * 60 * 1000;
		if (Date.now() - this.lastActivity < idleMs) return;
		if (this.busy()) {
			this.lastActivity = Date.now();
			return;
		}
		void this.shutdown(0);
	}

	async shutdown(code = 0): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		if (this.idleTimer !== null) clearInterval(this.idleTimer);
		this.idleTimer = null;
		for (const [, p] of this.pendingPermissions) {
			clearTimeout(p.timer);
			p.resolve({ approved: false, scope: "once" });
		}
		this.pendingPermissions.clear();
		// 存活会话的结束语义（07 §2 session.end：结束原因 daemon-shutdown）
		for (const s of this.sessions.list()) {
			if (s.status === "running" || s.status === "detached") {
				this.telemetry.emit("session.end", { reason: "daemon-shutdown" }, { sessionId: s.sessionId });
			}
		}
		await this.server.close();
		this.telemetry.close();
		this.syncMetrics();
		for (const c of this.mcp.clients) c.stop();
		this.onExit?.(code);
	}

	// —— RPC dispatch ——

	private async dispatch(method: string, params: Record<string, unknown>, conn: RpcConnection): Promise<unknown> {
		this.touch();
		switch (method) {
			case Methods.daemonPing:
				return { env: this.opts.env, pid: process.pid, upSince: this.startedAt };

			case Methods.daemonShutdown:
				// 延迟启动退出：让本次响应先 flush 出连接
				setTimeout(() => void this.shutdown(0), 50);
				return "shutting down";

			case Methods.sessionList:
				// mode 为 daemon 侧事实源（03 §7.3），随列表带给 TUI 状态行
				return this.sessions.list().map((row) => ({ ...row, mode: this.sessionMode(row.sessionId) }));

			case Methods.sessionNew: {
				const r = this.sessions.new({ workspace: strOrNull(params.workspace) });
				this.telemetry.emit("session.start", { workspace: params.workspace }, { sessionId: r.sessionId });
				this.writeState();
				return r;
			}

			case Methods.sessionAttach: {
				const id = requireStr(params.sessionId);
				const cursor = typeof params.cursor === "number" ? params.cursor : undefined;
				return this.sessions.attach(id, conn.id, cursor);
			}

			case Methods.sessionDetach: {
				const id = requireStr(params.sessionId);
				this.sessions.detach(id, conn.id);
				return { detached: id };
			}

			case Methods.sessionSend: {
				const id = requireStr(params.sessionId);
				const text = requireStr(params.text);
				this.sessions.send(id, text);
				this.writeState();
				return { queued: true, entryCount: this.sessions.get(id)?.entryCount ?? 0 };
			}

			case Methods.sessionInfo: {
				const id = requireStr(params.sessionId);
				const loop = this.sessions.get(id)?.loop;
				return {
					sessionId: id,
					mode: this.sessionMode(id),
					runtime: loop?.runtimeInfo?.() ?? null,
				};
			}

			case Methods.sessionSetThinking: {
				const id = requireStr(params.sessionId);
				const level = requireStr(params.level);
				if (!["off", "low", "medium", "high"].includes(level)) {
					throw new Error(`非法思考强度：${level}（off | low | medium | high）`);
				}
				const loop = this.sessions.get(id)?.loop;
				loop?.setThinkingLevel?.(level as "off" | "low" | "medium" | "high");
				return { sessionId: id, thinkingLevel: loop?.runtimeInfo?.().thinkingLevel ?? level };
			}

			case Methods.sandboxStatus: {
				const id = requireStr(params.sessionId);
				const act = this.sandboxTracker.get(id);
				if (act === null) return { sessionId: id, activity: null };
				return { sessionId: id, activity: act, changes: this.sandboxTracker.pendingChanges(id) };
			}

			case Methods.sandboxRollback: {
				// 撤销入口（03 §6.2 回滚；TUI /undo 弹窗确认后调用）
				const id = requireStr(params.sessionId);
				const baseline = params.baseline === true;
				const turn = typeof params.turn === "number" ? params.turn : undefined;
				const r = this.sandboxTracker.rollbackTo(id, { baseline, turn });
				if (!r.ok) throw new Error(r.detail);
				this.telemetry.emit(
					"sandbox.settle",
					{ activityId: id.slice(0, 8), mode: "inplace", outcome: "discard" },
					{ sessionId: id },
				);
				return { sessionId: id, detail: r.detail };
			}

			case Methods.sessionEnd: {
				const id = requireStr(params.sessionId);
				this.sessions.end(id);
				this.writeState();
				return { ended: id };
			}

			case Methods.sessionSetMode: {
				const id = requireStr(params.sessionId);
				const mode = requireStr(params.mode);
				if (!["plan", "approve", "full-auto"].includes(mode)) {
					throw new Error(`非法权限模式：${mode}（plan | approve | full-auto）`);
				}
				this.sessionModes.set(id, mode as PermissionMode);
				return { sessionId: id, mode: this.sessionMode(id) };
			}

			case Methods.swarmSpawn:
				return this.swarm.spawn({
					role: requireStr(params.role),
					brief: requireStr(params.brief),
					workspaceMode:
						params.workspaceMode === "own-worktree" ||
						params.workspaceMode === "shared-worktree" ||
						params.workspaceMode === "read-only"
							? params.workspaceMode
							: undefined,
					workspace: strOrNull(params.workspace),
				});

			case Methods.swarmStatus:
				return this.swarm.status();

			case Methods.swarmCancel:
				return this.swarm.cancel(requireStr(params.cellId));

			case Methods.swarmSend:
				return this.swarm.send(
					typeof params.from === "string" ? params.from : MAIN_CELL_ID,
					requireStr(params.to),
					requireStr(params.payload),
				);

			case Methods.swarmRead:
				return this.swarm.read(requireStr(params.cellId), {
					consume: params.consume !== false,
				});

			case Methods.wikiSearch: {
				const ws = requireStr(params.workspace);
				const { buildIndex, listPages, searchWiki } = await importWiki();
				return searchWiki(buildIndex(listPages(ws)), requireStr(params.query));
			}

			case Methods.wikiRead: {
				const page = (await importWiki()).readPage(requireStr(params.workspace), requireStr(params.page));
				if (page === null) throw new Error(`wiki page not found: ${params.page}`);
				return page;
			}

			case Methods.wikiUpdate:
				return (await importWiki()).updatePage(
					requireStr(params.workspace),
					requireStr(params.page),
					requireStr(params.content),
				);

			case Methods.wikiBuild:
				return (await importWiki()).buildWiki(requireStr(params.workspace), {
					moduleSupplier: () => (typeof params.moduleBody === "string" ? params.moduleBody : null) ?? null,
				});

			case Methods.wikiRefresh: {
				const mod = await importWiki();
				return mod.refreshWiki(requireStr(params.workspace), {
					supplier: () => (typeof params.moduleBody === "string" ? params.moduleBody : null) ?? null,
				});
			}

			case Methods.todoWrite: {
				const taskId = requireStr(params.taskId);
				const ops = (Array.isArray(params.ops) ? params.ops : []) as never[];
				const r = this.todos.write(taskId, ops, {
					expectedRevision: typeof params.revision === "number" ? params.revision : undefined,
				});
				this.server.broadcast(Notifications.todoEvents, { taskId, diff: r.diff, revision: r.board.revision });
				return r.board;
			}

			case Methods.todoRead: {
				return this.todos.read(requireStr(params.taskId));
			}

			case Methods.todoList: {
				return this.todos.list();
			}

			case Methods.permissionRespond: {
				const requestId = requireStr(params.requestId);
				const p = this.pendingPermissions.get(requestId);
				if (p === undefined) throw new Error(`no pending permission: ${requestId}`);
				this.pendingPermissions.delete(requestId);
				clearTimeout(p.timer);
				const answer: PermissionAnswer = {
					approved: params.approved === true,
					scope: (["once", "session", "env-always"] as const).includes(params.scope as never)
						? (params.scope as PermissionAnswer["scope"])
						: "once",
				};
				this.telemetry.emit("permission.decision", {
					privilege: p.privilege,
					decision: answer.approved ? answer.scope : "deny",
					requestId,
				});
				p.resolve(answer);
				return { answered: requestId };
			}

			case Methods.taskStatus: {
				const id = typeof params.taskId === "string" ? params.taskId : undefined;
				return { tasks: id === undefined ? this.tasks.list() : [this.tasks.get(id)] };
			}

			case Methods.taskStart:
				return this.tasks.start({
					goal: requireStr(params.goal),
					workspace: strOrNull(params.workspace),
					sessionId: strOrNull(params.sessionId),
					deliverables: Array.isArray(params.deliverables)
						? (params.deliverables as DeliverableSpec[])
						: undefined,
				});

			case Methods.taskConfirm:
				return this.tasks.confirm(requireStr(params.taskId));

			case Methods.taskReplan:
				return this.tasks.replan(
					requireStr(params.taskId),
					Array.isArray(params.deliverables) ? (params.deliverables as DeliverableSpec[]) : undefined,
				);

			case Methods.taskVerify:
				return this.tasks.verify(requireStr(params.taskId));

			case Methods.taskSettle:
				return this.tasks.settle(requireStr(params.taskId));

			case Methods.taskClose:
				return this.tasks.close(requireStr(params.taskId));

			case Methods.taskCancel:
				return this.tasks.cancel(requireStr(params.taskId));

			case Methods.taskResume:
				return this.tasks.resume(requireStr(params.taskId));

			case Methods.taskChangeRequest:
				return this.tasks.changeRequest(
					requireStr(params.taskId),
					(Array.isArray(params.changes) ? params.changes : []) as DeliverableChange[],
				);

			case Methods.taskApproveChange:
				return this.tasks.approveChange(requireStr(params.taskId), params.accept === true);

			case Methods.costSnapshot: {
				const snap: CostSnapshot = {
					env: this.opts.env,
					sessions: this.sessions.list().map((s) => ({
						sessionId: s.sessionId,
						tokens: s.tokens,
						costUsd: s.costUsd,
					})),
					totals: { input: 0, output: 0, costUsd: 0 },
				};
				for (const s of snap.sessions) {
					snap.totals.input += s.tokens.input;
					snap.totals.output += s.tokens.output;
					snap.totals.costUsd = Math.round((snap.totals.costUsd + s.costUsd) * 1e6) / 1e6;
				}
				return snap;
			}

			default:
				throw new Error(`${RpcErrorCode.methodNotFound}: method not found: ${method}`);
		}
	}

	/** P4：默认循环选择（piModel 配置时走真实 agent loop，否则 Echo） */
	private defaultLoop(opts: DaemonCoreOptions): AgentLoop {
		if (opts.piModel !== undefined) {
			const { PiAgentLoop } = piLoopModule;
			return new PiAgentLoop(opts.piModel);
		}
		return new EchoAgentLoop();
	}

	// —— 权限申请（sandbox-guard 经此请求；TUI 弹窗应答，03 §7.2） ——

	/** 工具执行条目落会话流（pi-loop onToolEvent → TUI 折叠行，04 §5.3） */
	appendToolEntry(sessionId: string, e: { name: string; argsDigest: string; ok: boolean; durationMs: number }): void {
		this.sessions.appendToolEntry(sessionId, e);
	}

	/** 会话权限模式（默认取环境默认值；TUI /mode 经 session.set_mode 覆盖） */
	sessionMode(sessionId: string): PermissionMode {
		return this.sessionModes.get(sessionId) ?? this.opts.defaultPermissionMode ?? "approve";
	}

	/** daemon 退出时把事件流 ETL 进 metrics.db（07 §4：daemon 空闲/退出触发） */
	private syncMetrics(): void {
		try {
			const dir = join(this.opts.home, "telemetry");
			if (!existsSync(join(dir, "events"))) return;
			rebuildMetrics(join(dir, "metrics.db"), join(dir, "events"));
		} catch {
			// ETL 失败不阻塞退出；下次 rebuild 从游标续跑
		}
	}

	requestPermission(req: Omit<PermissionRequestPending, "requestId">, timeoutMs?: number): Promise<PermissionAnswer> {
		const t = timeoutMs ?? this.opts.permissionTimeoutMs ?? 120000;
		const requestId = `perm-${this.nextPermissionId++}`;
		const pending: PermissionRequestPending = { requestId, ...req };
		this.telemetry.emit(
			"permission.request",
			{ privilege: req.privilege, tool: req.detail.tool, reason: req.reason, mode: req.detail.mode },
			{},
		);
		return new Promise<PermissionAnswer>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingPermissions.delete(requestId);
				resolve({ approved: false, scope: "once" }); // 超时视为拒绝
			}, t);
			this.pendingPermissions.set(requestId, { resolve, timer, privilege: req.privilege });
			this.server.broadcast(Notifications.permissionRequest, {
				request: pending,
				timeoutMs: t,
			});
		});
	}
}

// —— 局部小工具 ——

/** 延迟加载 wiki 模块（避免 daemon 启动路径引入全文检索依赖面） */
async function importWiki(): Promise<typeof import("../../core/src/wiki.ts")> {
	return await import("../../core/src/wiki.ts");
}

function requireStr(v: unknown): string {
	if (typeof v !== "string" || v.length === 0) throw new Error("参数缺失或非法（须为非空字符串）");
	return v;
}

function strOrNull(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}
