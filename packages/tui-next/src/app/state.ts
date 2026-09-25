/**
 * 三栏界面的信号化状态（opencode 范式：状态 = 信号存储，UI 读信号自动重渲染，
 * 无手动 requestRender）。纯函数（分组/状态点/页签操作/条目解析）保留为可测单元。
 * 数据来源：daemon RPC（data.ts 在 batch 内落地，保证单次渲染）。
 */

import type {
	CostSnapshot,
	DeliverableSpec,
	SessionListItem,
	SwarmCellInfo,
	TaskInfo,
	TaskPhase,
} from "../../../rpc/src/protocol.ts";
import { createSignal } from "../signal.ts";
import type { CompletionState } from "./completion.ts";
import type { DialogState } from "./dialogs.ts";
import { PondaEditor } from "./editor.ts";

export interface TaskSummary {
	taskId: string;
	goal: string;
	phase: TaskPhase;
	contractRevision: number;
	pendingChanges: boolean;
	deliverables: DeliverableSpec[];
}

export function taskSummaryOf(t: TaskInfo): TaskSummary {
	return {
		taskId: t.taskId,
		goal: t.goal,
		phase: t.phase,
		contractRevision: t.contractRevision,
		pendingChanges: t.pendingChanges !== null && t.pendingChanges.length > 0,
		deliverables: structuredClone(t.deliverables),
	};
}

export interface SwarmBar {
	cells: SwarmCellInfo[];
	/** 选中的 cell（null = main 会话） */
	selectedCellId: string | null;
	/** main 会话 id（切回用） */
	mainSessionId: string | null;
}

/** cell 状态点（04 §5.5） */
export function cellDot(status: SwarmCellInfo["status"]): string {
	switch (status) {
		case "running":
		case "spawning":
		case "retrying":
			return "●";
		case "done":
			return "✔";
		case "failed":
			return "✘";
		case "cancelled":
			return "⊘";
		default:
			return "○";
	}
}

/** 成果状态点（05 §4：右栏常驻展示） */
export function deliverableDot(status: DeliverableSpec["status"]): string {
	switch (status) {
		case "verified":
			return "✔";
		case "failed":
			return "✘";
		case "in_progress":
		case "delivered":
			return "◐";
		case "changed-pending":
			return "⚠";
		default:
			return "○";
	}
}

export interface SessionRow {
	sessionId: string;
	workspace: string | null;
	status: SessionListItem["status"];
	processing: boolean;
	attached: number;
	tokens: { input: number; output: number };
	costUsd: number;
}

export interface ChatEntry {
	/** 条目序号（含 header 的行号口径，attach 游标对齐） */
	cursor: number;
	kind: "user" | "assistant" | "notice" | "error";
	text: string;
	/** assistant 的思考块（pi 消息 content 里的 thinking 块，折叠展示） */
	thinking?: string;
}

export type LeftTab = "sessions" | "files";

/** 中栏标签页：主会话页 + 打开的文件页（04 §5.1/§5.6） */
export type CenterTab = { id: string; kind: "chat" } | { id: string; kind: "file"; path: string; name: string };

export interface Totals {
	input: number;
	output: number;
	costUsd: number;
}

export interface FileTree {
	root: string | null;
	expanded: ReadonlySet<string>;
	cursor: number;
}

export function applySessionListRows(list: SessionListItem[]): SessionRow[] {
	return list.map((s) => ({
		sessionId: s.sessionId,
		workspace: s.workspace,
		status: s.status,
		processing: s.processing,
		attached: s.attached,
		tokens: { ...s.tokens },
		costUsd: s.costUsd,
	}));
}

export function applyCostTotals(snap: CostSnapshot): Totals {
	return { ...snap.totals };
}

/** 解析一条 pi 会话 JSONL 行 → ChatEntry（header 计游标不渲染；返回 null 不入列） */
export function parseEntryLine(line: string): ChatEntry | null {
	let e: unknown;
	try {
		e = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof e !== "object" || e === null) return null;
	const entry = e as {
		type?: string;
		customType?: string;
		message?: { role?: string; content?: unknown };
	};
	if (entry.type === "session") return null; // header：占游标不渲染
	if (entry.type === "custom") {
		if (entry.customType === "ponda.ended" || entry.customType === "ponda.interrupted") {
			return {
				cursor: 0,
				kind: "notice",
				text: `— ${entry.customType.slice(6)} —`,
			};
		}
		return null;
	}
	if (entry.type !== "message" || entry.message === undefined) return null;
	const role = entry.message.role;
	const { text, thinking } = extractContent(entry.message.content);
	if (role === "user") {
		return text.length > 0 ? { cursor: 0, kind: "user", text } : null;
	}
	if (role === "assistant") {
		if (text.length > 0 || (thinking ?? "").length > 0) {
			return { cursor: 0, kind: "assistant", text, thinking: thinking ?? undefined };
		}
	}
	return null;
}

/** pi 消息 content（string | 块数组）→ text 与 thinking 两路 */
export function extractContent(content: unknown): { text: string; thinking: string | null } {
	if (typeof content === "string") return { text: content, thinking: null };
	if (!Array.isArray(content)) return { text: "", thinking: null };
	const texts: string[] = [];
	const thoughts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as { type?: string; text?: string; thinking?: string };
		if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
		else if (b.type === "thinking" && typeof b.thinking === "string") thoughts.push(b.thinking);
	}
	return { text: texts.join("\n"), thinking: thoughts.length > 0 ? thoughts.join("\n") : null };
}

/** 按工作区分组（左栏 §4.1）：null → "(no workspace)"，组内按 sessionId 稳定排序 */
export function groupByWorkspace(sessions: SessionRow[]): { workspace: string; rows: SessionRow[] }[] {
	const groups = new Map<string, SessionRow[]>();
	for (const s of sessions) {
		const key = s.workspace ?? "(no workspace)";
		const arr = groups.get(key) ?? [];
		arr.push(s);
		groups.set(key, arr);
	}
	return [...groups.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : 1))
		.map(([workspace, rows]) => ({ workspace, rows: rows.sort((x, y) => (x.sessionId < y.sessionId ? -1 : 1)) }));
}

/** 状态点（04 §4.1）：running ● / detached ◐ / ended ○ / interrupted ⚠ */
export function statusDot(s: SessionRow): string {
	switch (s.status) {
		case "running":
			return "●";
		case "detached":
			return "◐";
		case "interrupted":
			return "⚠";
		default:
			return "○";
	}
}

export function pickNextSession(sessions: SessionRow[], currentId: string | null): string | null {
	const ids = sessions.map((s) => s.sessionId);
	if (ids.length === 0) return null;
	const i = currentId !== null ? ids.indexOf(currentId) : -1;
	return ids[(i + 1) % ids.length] ?? ids[0];
}

/** 打开文件页签（已打开则激活；04 §5.6）——纯函数，返回新数组 */
export function openFileTab(tabs: CenterTab[], path: string, name: string): CenterTab[] {
	const id = `file:${path}`;
	const existing = tabs.find((t) => t.id === id);
	if (existing === undefined) return [...tabs, { id, kind: "file", path, name }];
	return tabs;
}

/** 关闭页签（主会话页不可关）；若关闭的是激活页则回退到前一页——纯函数 */
export function closeTab(tabs: CenterTab[], activeTabId: string, id: string): { tabs: CenterTab[]; activeId: string } {
	const i = tabs.findIndex((t) => t.id === id);
	if (i <= 0) return { tabs, activeId: activeTabId };
	const next = tabs.slice();
	next.splice(i, 1);
	const activeId = activeTabId === id ? ((next[Math.max(0, i - 1)] ?? next[0])?.id ?? "chat") : activeTabId;
	return { tabs: next, activeId };
}

/** 环切中栏标签页（']' / '[' 键；04 §7 Ctrl-Tab 的终端可达替代）——纯函数 */
export function cycleTab(tabs: CenterTab[], activeTabId: string, dir: 1 | -1): string {
	const i = tabs.findIndex((t) => t.id === activeTabId);
	const n = tabs.length;
	if (n === 0) return "chat";
	return tabs[(i + dir + n) % n]?.id ?? tabs[0]?.id ?? "chat";
}

/** 信号存储：组件读这些 getter，动作改信号 → 帧循环自动重渲染 */
export interface TuiState {
	readonly env: string;
	sessions(): SessionRow[];
	setSessions(rows: SessionRow[]): void;
	totals(): Totals;
	setTotals(t: Totals): void;
	currentId(): string | null;
	setCurrentId(id: string | null): void;
	entries(): readonly ChatEntry[];
	appendEntryLine(line: string): void;
	/** 本地错误条目（daemon error 事件 → 红色 ⚠ 行，不落盘） */
	appendError(message: string): void;
	resetEntries(): void;
	entrySeq(): number;
	scroll(): number;
	setScroll(v: number): void;
	scrollBy(lines: number): void;
	/** 侧栏当前页（侧栏可见时生效） */
	leftTab(): LeftTab;
	toggleLeftTab(): void;
	/** 会话/文件侧栏是否可见（默认隐藏，opencode 式聚焦对话） */
	sidebarVisible(): boolean;
	/** 侧栏循环：隐藏 → 会话页 → 文件页 → 隐藏 */
	cycleSidebar(): void;
	tabs(): CenterTab[];
	setTabs(tabs: CenterTab[]): void;
	activeTabId(): string;
	setActiveTabId(id: string): void;
	/** 焦点模式：input（默认，直接打字）/ nav（Esc 进入，单键导航） */
	mode(): "input" | "nav";
	setMode(mode: "input" | "nav"): void;
	task(): TaskSummary | null;
	setTask(t: TaskSummary | null): void;
	swarm(): SwarmBar;
	setSwarm(s: SwarmBar): void;
	dialog(): DialogState;
	setDialog(d: DialogState): void;
	completion(): CompletionState | null;
	setCompletion(c: CompletionState | null): void;
	hint(): string;
	setHint(h: string): void;
	/** 编辑器为有状态缓冲；rev 信号驱动依赖它的帧重渲染 */
	readonly editor: PondaEditor;
	editorRev(): number;
	bumpEditor(): void;
	/** 生成中动画帧（app 层定时器驱动，仅 processing 时推进） */
	spinnerTick(): number;
	bumpSpinner(): void;
	fileTree(): FileTree;
	setFileTreeRoot(root: string | null): void;
	moveTreeCursor(delta: number): void;
	toggleTreeExpand(relPath: string): void;
}

export function createTuiState(env: string): TuiState {
	const [sessions, setSessions] = createSignal<SessionRow[]>([]);
	const [totals, setTotals] = createSignal<Totals>({ input: 0, output: 0, costUsd: 0 });
	const [currentId, setCurrentId] = createSignal<string | null>(null);
	const [entries, setEntries] = createSignal<ChatEntry[]>([]);
	const [scroll, setScroll] = createSignal(0);
	const [leftTab, setLeftTab] = createSignal<LeftTab>("sessions");
	const [tabs, setTabs] = createSignal<CenterTab[]>([{ id: "chat", kind: "chat" }]);
	const [activeTabId, setActiveTabId] = createSignal("chat");
	const [mode, setMode] = createSignal<"input" | "nav">("input");
	const [sidebarVisible, setSidebarVisible] = createSignal(false);
	const [spinnerTick, bumpSpinnerSignal] = createSignal(0);
	const [task, setTask] = createSignal<TaskSummary | null>(null);
	const [swarm, setSwarm] = createSignal<SwarmBar>({ cells: [], selectedCellId: null, mainSessionId: null });
	const [dialog, setDialog] = createSignal<DialogState>(null);
	const [completion, setCompletion] = createSignal<CompletionState | null>(null);
	const [hint, setHint] = createSignal("");
	const [editorRev, setEditorRev] = createSignal(0);
	const bumpEditor = (): void => {
		setEditorRev((v) => v + 1);
	};
	const [fileTreeState, setFileTreeState] = createSignal<FileTree>({
		root: null,
		expanded: new Set<string>(),
		cursor: 0,
	});
	let entrySeq = 0;
	const editor = new PondaEditor();

	return {
		env,
		sessions,
		setSessions,
		totals,
		setTotals,
		currentId,
		setCurrentId,
		entries,
		appendError(message: string): void {
			entrySeq++;
			setEntries((prev) => [...prev, { cursor: entrySeq, kind: "error", text: message }]);
		},
		appendEntryLine(line: string): void {
			entrySeq++;
			const parsed = parseEntryLine(line);
			if (parsed === null) return;
			parsed.cursor = entrySeq;
			setEntries((prev) => [...prev, parsed as ChatEntry]);
		},
		resetEntries(): void {
			entrySeq = 0;
			setEntries([]);
			setScroll(0);
		},
		entrySeq(): number {
			return entrySeq;
		},
		scroll,
		setScroll,
		scrollBy(lines: number): void {
			setScroll(Math.max(0, scroll() + lines));
		},
		leftTab,
		toggleLeftTab(): void {
			setLeftTab(leftTab() === "sessions" ? "files" : "sessions");
		},
		sidebarVisible,
		cycleSidebar(): void {
			if (!sidebarVisible()) {
				setSidebarVisible(true);
				setLeftTab("sessions");
			} else if (leftTab() === "sessions") {
				setLeftTab("files");
			} else {
				setSidebarVisible(false);
			}
		},
		tabs,
		setTabs,
		activeTabId,
		setActiveTabId,
		mode,
		setMode,
		spinnerTick,
		bumpSpinner(): void {
			bumpSpinnerSignal((v) => v + 1);
		},
		task,
		setTask,
		swarm,
		setSwarm,
		dialog,
		setDialog,
		completion,
		setCompletion,
		hint,
		setHint,
		editor,
		editorRev,
		bumpEditor,
		fileTree: fileTreeState,
		setFileTreeRoot(root: string | null): void {
			const cur = fileTreeState();
			if (cur.root === root) return;
			setFileTreeState({ root, expanded: new Set(), cursor: 0 });
		},
		moveTreeCursor(delta: number): void {
			const cur = fileTreeState();
			setFileTreeState({ ...cur, cursor: Math.max(0, cur.cursor + delta) });
		},
		toggleTreeExpand(relPath: string): void {
			const cur = fileTreeState();
			const expanded = new Set(cur.expanded);
			if (expanded.has(relPath)) expanded.delete(relPath);
			else expanded.add(relPath);
			setFileTreeState({ ...cur, expanded });
		},
	};
}
