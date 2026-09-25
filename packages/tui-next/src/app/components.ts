/**
 * 三栏界面的声明式组件（opencode 观感重设）。
 *
 * 默认视图 = opencode 式聚焦对话：居中限宽的消息流 + 圆角输入框 + 双侧信息页脚；
 * 会话/文件侧栏与 goal 面板按需出现（Tab / 任务存在时），不再常驻挤压对话区。
 * 组件 = 返回元素树的函数，在帧 effect 内求值；读到的信号自动成为帧依赖。
 */

import { readFileSync } from "node:fs";
import { box, type Element, modal, rich, type Span, scroll, type TextStyle, text } from "../element.ts";
import { DEFAULT_MD_THEME, type MdTheme, markdownElements } from "../markdown.ts";
import { renderTree } from "../paint.ts";
import { untrack } from "../signal.ts";
import type { DialogState } from "./dialogs.ts";
import { readFilePreview, scanTree } from "./files.ts";
import {
	type ChatEntry,
	cellDot,
	deliverableDot,
	groupByWorkspace,
	type SessionRow,
	statusDot,
	type TuiState,
} from "./state.ts";

const DIM: TextStyle = { dim: true };
const YELLOW: TextStyle = { fg: "yellow" };
const BOLD: TextStyle = { bold: true };
const CYAN: TextStyle = { fg: "cyan" };
const CYAN_BOLD: TextStyle = { fg: "cyan", bold: true };
const RED: TextStyle = { fg: "red" };
const REVERSE: TextStyle = { reverse: true };
const BORDER_COLOR = "brightBlack" as const;
const CHAT_MAX_WIDTH = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** markdown 解析缓存（attach 重放/轮询期间同一文本反复入帧） */
const mdCache = new Map<string, Element[]>();

function markdownCached(src: string, theme: MdTheme = DEFAULT_MD_THEME): Element[] {
	const hit = mdCache.get(src);
	if (hit !== undefined) return hit;
	const elements = markdownElements(src, theme);
	if (mdCache.size > 400) mdCache.clear();
	mdCache.set(src, elements);
	return elements;
}

function short(id: string | null): string {
	return id === null ? "—" : id.slice(0, 8);
}

function fmt(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function fmtTokens(s: SessionRow): string {
	return fmt(s.tokens.input + s.tokens.output);
}

function currentRow(state: TuiState): SessionRow | undefined {
	const id = state.currentId();
	return id === null ? undefined : state.sessions().find((s) => s.sessionId === id);
}

// —— 根组件 ——

export function App(state: TuiState): Element {
	return box({ flexDirection: "column" }, [
		Header(state),
		Body(state),
		ActivityLine(state),
		CompletionPopup(state),
		InputBox(state),
		StatusLineRow(state),
		Footer(state),
		DialogLayer(state),
	]);
}

/** 无头渲染一帧（纯函数测试 / `ponda tui --snapshot`） */
export function renderStateFrame(state: TuiState, width: number, height: number): string[] {
	return untrack(() => renderTree(App(state), width, height));
}

// —— 页眉 / 页脚 ——

function Header(state: TuiState): Element {
	const row = currentRow(state);
	const left: Span[] = [
		{ text: " ponda ", style: CYAN_BOLD },
		{ text: state.env, style: DIM },
	];
	const right: Span[] = [
		row !== undefined
			? { text: `${statusDot(row)} ${short(state.currentId())}`, style: DIM }
			: { text: "新会话", style: DIM },
	];
	return box({ height: 1, flexDirection: "row", justify: "spaceBetween", shrink: 0 }, [rich(left), rich(right)]);
}

function Footer(state: TuiState): Element {
	const total = state.totals().input + state.totals().output;
	const live = state.sessions().filter((s) => s.status === "running" || s.status === "detached").length;
	const left: Span[] = [
		{
			text: ` ${state.env} · ${live} 会话 · Σ ${fmt(total)} tok / $${state.totals().costUsd.toFixed(2)}`,
			style: DIM,
		},
	];
	const hint = state.hint();
	const right: Span[] =
		hint.length > 0
			? [{ text: `${hint} `, style: CYAN }]
			: state.mode() === "input"
				? [{ text: "⏎ 发送 · esc 导航 · ^x 快捷键 ", style: DIM }]
				: [{ text: "j/k 滚动 · t 侧栏 · q 退出 · esc 返回输入 ", style: DIM }];
	return box({ height: 1, flexDirection: "row", justify: "spaceBetween", shrink: 0 }, [rich(left), rich(right)]);
}

// —— 主体：侧栏（可选）+ 居中对话列 + goal 面板（有任务时）——

function Body(state: TuiState): Element {
	const children: Element[] = [];
	if (state.sidebarVisible()) children.push(Sidebar(state));
	children.push(ChatColumn(state));
	// 右栏三段（04 §4.3）：TODOLIST / 成果状态 / 权限通知——有内容时出现
	const right = RightPanel(state);
	if (right !== null) children.push(right);
	return box({ flexDirection: "row", grow: 1, minHeight: 3 }, children);
}

/** 右栏（04 §4.3 垂直三段）：看板存在或任务存在时整体出现 */
function RightPanel(state: TuiState): Element | null {
	const todo = state.todoBoard();
	if (todo === null && state.task() === null) return null;
	return box(
		{
			width: 30,
			shrink: 0,
			flexDirection: "column",
			border: { style: "round", color: BORDER_COLOR },
			paddingLeft: 1,
			paddingBottom: 1,
		},
		[TodoPanel(state), GoalPanel(state), NoticePanel(state)],
	);
}

/** 第 1 段：TODOLIST 看板（进度条 ▓/░ + 状态计数 + 条目） */
function TodoPanel(state: TuiState): Element {
	const board = state.todoBoard();
	if (board === null) return text({ text: "" });
	const total = board.items.length;
	const done = board.items.filter((i) => i.status === "done").length;
	const active = board.items.find((i) => i.status === "in_progress");
	const barCells = 20;
	const filled = total > 0 ? Math.round((done / total) * barCells) : 0;
	const children: Element[] = [
		box({ height: 1, shrink: 0 }, [rich([{ text: " TODO", style: BOLD }])]),
		rich([
			{
				text: ` ${"▓".repeat(filled)}${"░".repeat(barCells - filled)} ${done}/${total}${active !== undefined ? " ◐ 进行中" : ""}`,
				style: DIM,
			},
		]),
	];
	for (const item of board.items.slice(0, 8)) {
		children.push(text({ text: ` ${todoStatusMark(item.status)} ${item.id} ${item.text.slice(0, 18)}` }));
	}
	children.push(text({ text: "" }));
	return box({ flexDirection: "column" }, children);
}

/** 第 3 段：权限/通知（待应答计数与最近事件占位，04 §4.3） */
function NoticePanel(state: TuiState): Element {
	const children: Element[] = [box({ height: 1, shrink: 0 }, [rich([{ text: " 通知", style: BOLD }])])];
	if (state.dialog() !== null) {
		children.push(rich([{ text: " ⚠ 待确认（权限/契约/合并）", style: YELLOW }]));
	} else {
		children.push(rich([{ text: " 无待办", style: DIM }]));
	}
	return box({ flexDirection: "column" }, children);
}

function todoStatusMark(status: string): string {
	if (status === "done") return "●";
	if (status === "in_progress") return "◐";
	if (status === "blocked") return "⚠";
	if (status === "cancelled") return "✕";
	return "○";
}

/** 居中限宽容器（opencode 式）：内容列最大 CHAT_MAX_WIDTH，居中于剩余空间 */
function ChatColumn(state: TuiState): Element {
	const inner = box({ flexDirection: "column", width: "100%", maxWidth: CHAT_MAX_WIDTH }, [
		TabsRow(state),
		ChatContent(state),
	]);
	return box({ flexDirection: "row", grow: 1, justify: "center", align: "stretch" }, [inner]);
}

function TabsRow(state: TuiState): Element | null {
	const tabs = state.tabs();
	if (tabs.length <= 1) return null;
	const spans: Span[] = [{ text: " " }];
	tabs.forEach((t, i) => {
		if (i > 0) spans.push({ text: "  ", style: DIM });
		const label = t.kind === "chat" ? "chat" : `${t.name} ×`;
		spans.push({ text: label, style: t.id === state.activeTabId() ? BOLD : DIM });
	});
	return box({ height: 1, shrink: 0 }, [rich(spans)]);
}

function ChatContent(state: TuiState): Element {
	const entries = state.entries();
	if (state.currentId() === null && entries.length === 0) {
		return box({ grow: 1, align: "center", justify: "center", flexDirection: "column" }, [
			rich([{ text: "输入消息开始对话", style: DIM }]),
			rich([{ text: "Tab 会话列表 · Esc 导航模式", style: DIM }]),
		]);
	}
	if (entries.length === 0) {
		return box({ grow: 1, align: "center", flexDirection: "column" }, [rich([{ text: "（暂无消息）", style: DIM }])]);
	}
	const active = state.tabs().find((t) => t.id === state.activeTabId());
	if (active !== undefined && active.kind === "file") return FileContent(active.path);
	// 04 §5.3 聚合：连续同类工具条目 >5 条整组折叠为 `▸ N× name`（单遍索引分组）
	const runOf = new Map<number, { name: string; start: number; count: number }>();
	let cur: { name: string; start: number; count: number } | null = null;
	entries.forEach((entry, i) => {
		if (entry.kind !== "tool") {
			cur = null;
			return;
		}
		const name = entry.text.split(" ")[0] ?? "?";
		if (cur === null || cur.name !== name) cur = { name, start: i, count: 0 };
		cur.count++;
		runOf.set(i, cur);
	});
	const children: Element[] = [];
	entries.forEach((entry, i) => {
		if (entry.kind === "tool") {
			const run = runOf.get(i);
			if (run !== undefined && run.count > 5) {
				if (run.start === i) {
					children.push(box({ paddingLeft: 1 }, [rich([{ text: `▸ ${run.count}× ${run.name}`, style: DIM }])]));
				}
				return; // 组内其余条目被折叠吸收
			}
			children.push(...ChatEntryView(entry));
			return;
		}
		if (i > 0) children.push(text({ text: "" })); // 消息间空行
		children.push(...ChatEntryView(entry));
	});
	// offset = 距底部行数：0 跟随底部；j/k 调整
	return box({ grow: 1 }, [scroll(() => state.scroll(), children)]);
}

function FileContent(path: string): Element {
	const preview = readFilePreview(path);
	if (preview.markdown) {
		try {
			return box({ flexDirection: "column" }, markdownCached(readFileSync(path, "utf8")));
		} catch {
			return rich([{ text: "(无法渲染 markdown)", style: DIM }]);
		}
	}
	return box(
		{ flexDirection: "column" },
		preview.lines.map((l) => text({ text: l })),
	);
}

function ChatEntryView(e: ChatEntry): Element[] {
	if (e.kind === "tool") {
		// 04 §5.3 工具折叠行：▸ bash cmd…（✔ 0.3s）；失败 ✘ 默认展开一行
		const secs = ((e.durationMs ?? 0) / 1000).toFixed(1);
		const mark = e.ok !== false ? { text: `（✔ ${secs}s）`, style: DIM } : { text: `（✘ ${secs}s）`, style: RED };
		return [box({ paddingLeft: 1 }, [rich([{ text: "▸ ", style: DIM }, { text: e.text, style: DIM }, mark])])];
	}
	if (e.kind === "notice") {
		return [rich([{ text: e.text, style: DIM }])];
	}
	if (e.kind === "error") {
		return [rich([{ text: `⚠ ${e.text}`, style: RED }])];
	}
	if (e.kind === "user") {
		return [box({ paddingLeft: 1 }, [rich([{ text: "❯ ", style: CYAN_BOLD }, { text: e.text }])])];
	}
	const out: Element[] = [];
	if (e.thinking !== undefined && e.thinking.length > 0) {
		const tok = Math.ceil(e.thinking.length / 4);
		out.push(rich([{ text: `✻ 思考 (${tok} tok)`, style: DIM }]));
	}
	if (e.text.length > 0) {
		for (const el of markdownCached(e.text)) out.push(el);
	}
	if (out.length === 0) out.push(text({ text: "" }));
	return out;
}

// —— 会话/文件侧栏 ——

function Sidebar(state: TuiState): Element {
	const page = state.leftTab();
	const title: Span[] =
		page === "sessions"
			? [
					{ text: " 会话", style: BOLD },
					{ text: `  ${state.sessions().length}`, style: DIM },
				]
			: [{ text: " 文件", style: BOLD }];
	const children: Element[] = [box({ height: 1, shrink: 0 }, [rich(title)])];
	if (page === "sessions") children.push(...SidebarSessions(state));
	else children.push(...SidebarFiles(state));
	return box(
		{
			width: 32,
			shrink: 0,
			flexDirection: "column",
			border: { style: "round", color: BORDER_COLOR },
			paddingLeft: 1,
			paddingBottom: 1,
		},
		children,
	);
}

function SidebarSessions(state: TuiState): Element[] {
	const children: Element[] = [];
	for (const group of groupByWorkspace(state.sessions())) {
		children.push(rich([{ text: `${group.workspace ?? "(no workspace)"} (${group.rows.length})`, style: DIM }]));
		for (const s of group.rows) {
			const active = s.sessionId === state.currentId();
			const processing = s.processing ? " ⋙" : "";
			children.push(
				rich([
					{
						text: `${statusDot(s)} ${short(s.sessionId)} ${fmtTokens(s)}${processing}`,
						style: active ? CYAN_BOLD : undefined,
					},
				]),
			);
		}
	}
	if (state.sessions().length === 0) children.push(rich([{ text: "(无会话)", style: DIM }]));
	const total = state.totals().input + state.totals().output;
	children.push(text({ text: "" }));
	children.push(rich([{ text: `Σ ${fmt(total)} tok · $${state.totals().costUsd.toFixed(2)}`, style: DIM }]));
	return children;
}

function SidebarFiles(state: TuiState): Element[] {
	const children: Element[] = [];
	const tree = state.fileTree();
	if (tree.root === null) {
		children.push(rich([{ text: "(当前会话无工作区)", style: DIM }]));
		return children;
	}
	const nodes = scanTree(tree.root, tree.expanded);
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (n === undefined) continue;
		const indent = "  ".repeat(n.depth);
		const marker = n.dir ? (tree.expanded.has(n.relPath) ? "▾" : "▸") : " ";
		const selected = i === tree.cursor;
		children.push(rich([{ text: `${indent}${marker} ${n.name}`, style: selected ? REVERSE : undefined }]));
	}
	children.push(text({ text: "" }));
	children.push(rich([{ text: `${nodes.length} 项`, style: DIM }]));
	return children;
}

// —— goal 面板（有任务时常驻右侧，04 §4.3）——

function GoalPanel(state: TuiState): Element {
	const task = state.task();
	if (task === null) return text({ text: "" });
	const children: Element[] = [
		box({ height: 1, shrink: 0 }, [rich([{ text: " goal", style: BOLD }])]),
		rich([
			{
				text: ` ${task.phase} v${task.contractRevision}${task.pendingChanges ? " ⚠变更" : ""}`,
				style: DIM,
			},
		]),
		text({ text: "" }),
	];
	for (const d of task.deliverables.slice(0, 8)) {
		children.push(text({ text: ` ${deliverableDot(d.status)} ${d.id} ${d.name}` }));
	}
	children.push(text({ text: "" }));
	return box({ flexDirection: "column" }, children);
}

// —— 输入区上方：生成中指示 + 子 agent 切换条 ——

function ActivityLine(state: TuiState): Element | null {
	const swarm = state.swarm();
	const processing = currentRow(state)?.processing ?? false;
	if (!processing && swarm.cells.length === 0) return null;
	const spans: Span[] = [{ text: " " }];
	if (processing) {
		const frame = SPINNER_FRAMES[state.spinnerTick() % SPINNER_FRAMES.length];
		spans.push({ text: `${frame} `, style: CYAN });
		spans.push({ text: "生成中…", style: DIM });
	}
	if (swarm.cells.length > 0) {
		if (processing) spans.push({ text: "   ", style: DIM });
		spans.push({ text: "main", style: swarm.selectedCellId === null ? REVERSE : undefined });
		spans.push({ text: " │ ", style: DIM });
		swarm.cells.slice(0, 8).forEach((c, i) => {
			if (i > 0) spans.push({ text: " " });
			const selected = c.cellId === swarm.selectedCellId;
			spans.push({ text: `${i + 1} ${c.role} ${cellDot(c.status)}`, style: selected ? REVERSE : undefined });
		});
	}
	return box({ height: 1, shrink: 0 }, [rich(spans)]);
}

function CompletionPopup(state: TuiState): Element | null {
	const completion = state.completion();
	if (completion === null) return null;
	const header = completion.kind === "@" ? "文件" : "命令";
	const children: Element[] = [rich([{ text: `${header}补全（Tab 选中 ↓↑ 切换 Esc 关闭）`, style: DIM }])];
	completion.candidates.forEach((c, i) => {
		const selected = i === completion.selected;
		children.push(rich([{ text: `${selected ? "▸" : " "}${c}`, style: selected ? CYAN_BOLD : DIM }]));
	});
	return box({ flexDirection: "column", maxHeight: 6, paddingLeft: 1, shrink: 0 }, children);
}

/** 圆角输入框（opencode 式）：❯ 提示符 + 占位符 + 块状光标 */
function InputBox(state: TuiState): Element {
	void state.editorRev(); // 依赖：编辑器缓冲变化时重建
	const editor = state.editor;
	const inputMode = state.mode() === "input";
	const lines: Element[] = [];
	if (editor.isEmpty) {
		const placeholder = inputMode ? "输入消息…" : "（导航模式——按任意字符返回输入）";
		lines.push(
			rich([
				{ text: "❯ ", style: CYAN_BOLD },
				{ text: placeholder, style: DIM },
			]),
		);
	} else {
		editor.lines.forEach((line, i) => {
			const isCursorRow = i === editor.row;
			const before = isCursorRow ? line.slice(0, editor.col) : line;
			const after = isCursorRow ? line.slice(editor.col) : "";
			const cursorSpan: Span[] = isCursorRow && inputMode ? [{ text: "▏", style: CYAN }] : [];
			const prefix = i === 0 ? { text: "❯ ", style: CYAN_BOLD } : { text: "  " };
			lines.push(rich([prefix, { text: before }, ...cursorSpan, { text: after }]));
		});
	}
	return box(
		{
			flexDirection: "column",
			border: { style: "round", color: inputMode ? "cyan" : BORDER_COLOR },
			paddingLeft: 1,
			paddingRight: 1,
			maxHeight: 8,
			shrink: 0,
		},
		lines,
	);
}

/** 输入区状态行（04 §5.4）：mode/思考强度/模型/上下文占用；超 80% 警示 /compact */
function StatusLineRow(state: TuiState): Element {
	void state.editorRev(); // 跟随帧刷新（mode 切换/轮询更新信号）
	const sl = state.statusLine();
	const pct = sl.ctxWindow > 0 ? sl.ctxUsed / sl.ctxWindow : 0;
	const ctxText =
		sl.ctxWindow > 0 ? `ctx ${fmt(sl.ctxUsed)}/${fmt(sl.ctxWindow)}（${Math.round(pct * 100)}%）` : "ctx —";
	const left: Span[] = [
		{ text: ` mode: ${sl.mode} · think: ${sl.thinking} · model: ${sl.modelId} · ${ctxText}`, style: DIM },
	];
	if (pct >= 0.8) {
		left.push({ text: "  ⚠ 上下文即将超限，可 /compact", style: YELLOW });
	}
	return box({ height: 1, flexDirection: "row", shrink: 0 }, [rich(left)]);
}

// —— 弹窗（modal 居中覆盖）——

function DialogLayer(state: TuiState): Element | null {
	const dialog = state.dialog();
	if (dialog === null) return null;
	return modal({ width: 64, maxHeight: 12, border: { style: "round", color: BORDER_COLOR } }, DialogBody(dialog));
}

function DialogBody(dialog: Exclude<DialogState, null>): Element[] {
	const children: Element[] = [];
	const line = (s: string, style?: TextStyle): void => {
		children.push(style === undefined ? text({ text: s }) : rich([{ text: s, style }]));
	};
	if (dialog.kind === "permission") {
		line(`权限申请：${dialog.privilege}`, BOLD);
		line("");
		line(dialog.reason);
		if (dialog.detail.targetPath !== undefined) line(`目标：${dialog.detail.targetPath}`);
		if (dialog.detail.command !== undefined) line(`命令：${dialog.detail.command}`);
		line("");
		line("[y] 允许一次   [s] 本会话允许");
		line("[a] 总是允许   [n] 拒绝");
		return children;
	}
	if (dialog.kind === "merge") {
		line("合并 / 结算确认（sandbox）", BOLD);
		line("");
		for (const f of dialog.files.slice(0, 5)) line(`${f.status}  ${f.path}`);
		if (dialog.files.length > 5) line(`… 共 ${dialog.files.length} 个文件`);
		line("");
		line(dialog.note);
		line("");
		line("[Enter] apply   [d] discard   [Esc] 取消");
		return children;
	}
	if (dialog.kind === "contract") {
		line(`成果契约确认（replans: ${dialog.replans}）`, BOLD);
		line(`目标：${dialog.goal}`);
		line("");
		for (const d of dialog.deliverables.slice(0, 5)) {
			line(`${d.id} ${d.name} [${d.verifyType}] ${d.doneCriteria}`);
		}
		if (dialog.deliverables.length > 5) line(`… 共 ${dialog.deliverables.length} 项`);
		line("");
		line("[Enter] 确认冻结   [r] 打回重规划");
		line("[Esc] 稍后决定");
		return children;
	}
	line("契约变更审批", BOLD);
	line(`当前修订：v${dialog.contractRevision}`);
	line("");
	for (const c of dialog.changes.slice(0, 5)) {
		line(`${c.op} ${c.id} ${c.name}${c.reason !== undefined ? `（${c.reason}）` : ""}`);
	}
	line("");
	line("[y] 批准（修订+1）   [n] 拒绝");
	return children;
}
