/**
 * ponda 三栏读视图的视图模型（design: docs/design/04-tui.md §4/§5；M5 第一批）。
 * 数据源：daemon RPC（session.list / cost.snapshot / session.attach replay / session.events）。
 * 纯数据结构 + 纯函数，供 view 渲染与无头测试。
 */
import type {
	CostSnapshot,
	DeliverableSpec,
	SessionListItem,
	SwarmCellInfo,
	TaskInfo,
	TaskPhase,
} from "../../../rpc/src/protocol.ts";

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
	kind: "user" | "assistant" | "notice";
	text: string;
	/** assistant 的思考块（pi 消息 content 里的 thinking 块，M5-1 折叠展示） */
	thinking?: string;
}

export type LeftTab = "sessions" | "files";

/** 中栏标签页：主会话页 + 打开的文件页（04 §5.1/§5.6） */
export type CenterTab = { id: string; kind: "chat" } | { id: string; kind: "file"; path: string; name: string };

export interface ReadModel {
	env: string;
	sessions: SessionRow[];
	totals: { input: number; output: number; costUsd: number };
	currentId: string | null;
	entries: ChatEntry[];
	/** 中栏滚动偏移（行级） */
	scroll: number;
	entrySeq: number;
	/** 左栏页签（04 §4.1/§4.2） */
	leftTab: LeftTab;
	/** 中栏标签页栈 */
	centerTabs: CenterTab[];
	activeTabId: string;
	/** 输入区焦点（i 进入 / Esc 退出；04 §5.4） */
	inputMode: boolean;
	/** 当前 goal 任务摘要（右栏成果状态，05 §4.3） */
	task: TaskSummary | null;
	/** 子 agent 切换条（04 §5.5） */
	swarm: SwarmBar;
}

export function newReadModel(env: string): ReadModel {
	return {
		env,
		sessions: [],
		totals: { input: 0, output: 0, costUsd: 0 },
		currentId: null,
		entries: [],
		scroll: 0,
		entrySeq: 0,
		leftTab: "sessions",
		centerTabs: [{ id: "chat", kind: "chat" }],
		activeTabId: "chat",
		inputMode: false,
		task: null,
		swarm: { cells: [], selectedCellId: null, mainSessionId: null },
	};
}

export function applySessionList(m: ReadModel, list: SessionListItem[]): void {
	m.sessions = list.map((s) => ({
		sessionId: s.sessionId,
		workspace: s.workspace,
		status: s.status,
		processing: s.processing,
		attached: s.attached,
		tokens: { ...s.tokens },
		costUsd: s.costUsd,
	}));
}

export function applyCostSnapshot(m: ReadModel, snap: CostSnapshot): void {
	m.totals = { ...snap.totals };
}

export function resetEntries(m: ReadModel): void {
	m.entries = [];
	m.scroll = 0;
	m.entrySeq = 0;
}

/** 解析一条 pi 会话 JSONL 行 → ChatEntry（header 计游标不渲染） */
export function pushEntryLine(m: ReadModel, line: string): void {
	m.entrySeq++;
	let e: unknown;
	try {
		e = JSON.parse(line);
	} catch {
		return;
	}
	if (typeof e !== "object" || e === null) return;
	const entry = e as {
		type?: string;
		customType?: string;
		message?: { role?: string; content?: unknown };
	};
	if (entry.type === "session") return; // header：占游标不渲染
	if (entry.type === "custom") {
		if (entry.customType === "ponda.ended" || entry.customType === "ponda.interrupted") {
			m.entries.push({ cursor: m.entrySeq, kind: "notice", text: `— ${entry.customType.slice(6)} —` });
		}
		return;
	}
	if (entry.type !== "message" || entry.message === undefined) return;
	const role = entry.message.role;
	const { text, thinking } = extractContent(entry.message.content);
	if (role === "user") {
		if (text.length > 0) m.entries.push({ cursor: m.entrySeq, kind: "user", text });
		return;
	}
	if (role === "assistant") {
		if (text.length > 0 || (thinking ?? "").length > 0) {
			m.entries.push({ cursor: m.entrySeq, kind: "assistant", text, thinking: thinking ?? undefined });
		}
	}
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

export function pickNextSession(m: ReadModel): string | null {
	const ids = m.sessions.map((s) => s.sessionId);
	if (ids.length === 0) return null;
	const i = m.currentId !== null ? ids.indexOf(m.currentId) : -1;
	return ids[(i + 1) % ids.length] ?? ids[0];
}

export function clampScroll(m: ReadModel, maxLines: number): void {
	m.scroll = Math.max(0, Math.min(m.scroll, Math.max(0, maxLines - 1)));
}

/** 打开文件页签（已打开则激活；04 §5.6） */
export function openFileTab(m: ReadModel, path: string, name: string): void {
	const id = `file:${path}`;
	const existing = m.centerTabs.find((t) => t.id === id);
	if (existing === undefined) {
		m.centerTabs.push({ id, kind: "file", path, name });
	}
	m.activeTabId = id;
}

export function closeTab(m: ReadModel, id: string): void {
	const i = m.centerTabs.findIndex((t) => t.id === id);
	if (i <= 0) return; // 主会话页不可关
	m.centerTabs.splice(i, 1);
	if (m.activeTabId === id) {
		m.activeTabId = (m.centerTabs[Math.max(0, i - 1)] ?? m.centerTabs[0])?.id ?? "chat";
	}
}

/** 环切中栏标签页（[')' / ']' 键；04 §7 Ctrl-Tab 的终端可达替代） */
export function cycleTab(m: ReadModel, dir: 1 | -1): void {
	const i = m.centerTabs.findIndex((t) => t.id === m.activeTabId);
	const n = m.centerTabs.length;
	if (n === 0) return;
	m.activeTabId = m.centerTabs[(i + dir + n) % n]?.id ?? m.centerTabs[0]?.id ?? "chat";
}
