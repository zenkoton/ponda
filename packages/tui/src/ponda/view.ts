/**
 * 三栏视图渲染（M5 全量：读视图 + 页签 + 输入区 + 补全弹层 + 弹窗合成）。
 * 左：会话/文件页签（§4.1/§4.2）+ token/费用；中：标签页（chat/文件预览 §5.1/§5.6）
 * + markdown/思考折叠 + 底部输入区与补全弹层（§5.4）；右：todolist 占位。
 */
import { readFileSync } from "node:fs";
import { Markdown } from "../components/markdown.ts";
import { visibleWidth } from "../utils.ts";
import { type CompletionState, renderCompletionPopup } from "./completion.ts";
import { compositeDialog, type DialogState } from "./dialogs.ts";
import type { PondaEditor } from "./editor.ts";
import { type FileTreeState, readFilePreview, scanTree } from "./files.ts";
import {
	type ChatEntry,
	cellDot,
	deliverableDot,
	groupByWorkspace,
	type ReadModel,
	type SessionRow,
	statusDot,
} from "./model.ts";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const REVERSE = "\x1b[7m";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

const MD_THEME = {
	heading: (t: string) => `${BOLD}${t}${RESET}`,
	link: (t: string) => `${CYAN}${t}${RESET}`,
	linkUrl: (t: string) => `${DIM}${t}${RESET}`,
	code: (t: string) => `${YELLOW}${t}${RESET}`,
	codeBlock: (t: string) => `${DIM}${t}${RESET}`,
	codeBlockBorder: (t: string) => `${DIM}${t}${RESET}`,
	quote: (t: string) => `${DIM}${t}${RESET}`,
	quoteBorder: (t: string) => `${DIM}${t}${RESET}`,
	hr: (t: string) => `${DIM}${t}${RESET}`,
	listBullet: (t: string) => `${YELLOW}${t}${RESET}`,
	bold: (t: string) => `${BOLD}${t}${RESET}`,
	italic: (t: string) => `${t}`,
	strikethrough: (t: string) => `${DIM}${t}${RESET}`,
	underline: (t: string) => `${t}`,
};

export interface InputAreaState {
	editor: PondaEditor;
	completion: CompletionState | null;
	hint: string;
}

export interface FrameSources {
	model: ReadModel;
	input: InputAreaState;
	dialog: DialogState;
	fileTree: FileTreeState;
}

/** 渲染完整帧（弹窗最后合成居中覆盖） */
export function renderFrame(s: FrameSources, width: number, height: number): string[] {
	const m = s.model;
	const leftWidth = Math.max(20, Math.min(30, Math.floor(width * 0.28)));
	const rightWidth = Math.max(18, Math.min(24, Math.floor(width * 0.2)));
	const centerWidth = Math.max(10, width - leftWidth - rightWidth - 2);

	const swarmBar = renderSwarmBar(m, width);
	const inputBlock = [...swarmBar, ...renderInputArea(s.input, width)];
	const bodyHeight = Math.max(3, height - 2 - inputBlock.length);

	const header = renderHeader(m, width);
	const left =
		m.leftTab === "sessions"
			? renderLeftSessions(m, leftWidth, bodyHeight)
			: renderLeftFiles(s, leftWidth, bodyHeight);
	const center = renderCenterTabs(s, centerWidth, bodyHeight);
	const right = renderRight(m, rightWidth, bodyHeight);
	const footer = renderFooter(m, s.input.hint, width);

	const rows: string[] = [];
	for (let i = 0; i < bodyHeight; i++) {
		rows.push(
			`${padVisible(left[i] ?? "", leftWidth)}${DIM}│${RESET}${padVisible(center[i] ?? "", centerWidth)}${DIM}│${RESET}${padVisible(right[i] ?? "", rightWidth)}`,
		);
	}
	return compositeDialog([header, ...rows, ...inputBlock, footer], s.dialog);
}

function renderHeader(m: ReadModel, width: number): string {
	const cur = m.sessions.find((x) => x.sessionId === m.currentId);
	const status = cur !== undefined ? `${statusDot(cur)} ${cur.status}` : "—";
	const title = ` ponda tui ${DIM}·${RESET} env:${BOLD}${m.env}${RESET} ${DIM}·${RESET} session ${CYAN}${short(m.currentId)}${RESET} ${DIM}(${status})${RESET}`;
	return clipVisible(title, width);
}

// —— 左栏 ——

function renderLeftSessions(m: ReadModel, width: number, height: number): string[] {
	const inner = Math.max(6, width - 2);
	const lines: string[] = [tabRow(m, inner)];
	for (const group of groupByWorkspace(m.sessions)) {
		const label = clipVisible(`▾ ${group.workspace} (${group.rows.length})`, inner);
		lines.push(`${DIM}${label}${RESET}`);
		for (const s of group.rows) {
			const active = s.sessionId === m.currentId && m.activeTabId === "chat";
			const row = clipVisible(
				` ${statusDot(s)} ${short(s.sessionId)} ${fmtTokens(s)} $${s.costUsd.toFixed(2)}`,
				inner,
			);
			lines.push(active ? `${BOLD}${row}${RESET}` : row);
		}
		if (lines.length >= height - 1) break;
	}
	if (m.sessions.length === 0) lines.push(`${DIM}(无会话)${RESET}`);
	const total = m.totals.input + m.totals.output;
	lines.push(`${DIM}Σ ${fmt(total)} tok · $${m.totals.costUsd.toFixed(2)}${RESET}`);
	return lines.slice(0, height);
}

function renderLeftFiles(s: FrameSources, width: number, height: number): string[] {
	const inner = Math.max(6, width - 2);
	const m = s.model;
	const lines: string[] = [tabRow(m, inner)];
	if (s.fileTree.root === null) {
		lines.push(`${DIM}(当前会话无工作区)${RESET}`);
		return lines.slice(0, height);
	}
	const nodes = scanTree(s.fileTree.root, s.fileTree.expanded);
	for (let i = 0; i < nodes.length && lines.length < height - 1; i++) {
		const n = nodes[i];
		if (n === undefined) continue;
		const indent = "  ".repeat(n.depth);
		const marker = n.dir ? (s.fileTree.expanded.has(n.relPath) ? "▾" : "▸") : " ";
		const selected = i === s.fileTree.cursor && m.leftTab === "files";
		let row = clipVisible(`${indent}${marker} ${n.name}`, inner);
		if (selected) row = `${REVERSE}${row}${RESET}`;
		lines.push(row);
	}
	lines.push(`${DIM}${nodes.length} 项${RESET}`);
	return lines.slice(0, height);
}

function tabRow(m: ReadModel, width: number): string {
	const sessions = m.leftTab === "sessions" ? `${BOLD}[会话]${RESET}` : `${DIM}[会话]${RESET}`;
	const files = m.leftTab === "files" ? `${BOLD}[文件]${RESET}` : `${DIM}[文件]${RESET}`;
	return clipVisible(`${sessions} ${files}`, width);
}

// —— 中栏 ——

function renderCenterTabs(s: FrameSources, width: number, height: number): string[] {
	const m = s.model;
	const tabsLine = m.centerTabs
		.map((t) => {
			const label =
				t.kind === "chat" ? `chat${m.currentId !== null ? ` ${short(m.currentId)}` : ""}` : `${t.name} ×`;
			return t.id === m.activeTabId ? `${BOLD}▶ ${label}${RESET}` : `${DIM}${label}${RESET}`;
		})
		.join(`${DIM} │${RESET} `);
	const lines = [clipVisible(tabsLine, width)];
	const active = m.centerTabs.find((t) => t.id === m.activeTabId);
	const content =
		active !== undefined && active.kind === "file"
			? renderFileContent(active.path, width, height - 1)
			: renderChat(m, width, height - 1);
	return [...lines, ...content].slice(0, height);
}

function renderFileContent(path: string, width: number, height: number): string[] {
	const preview = readFilePreview(path);
	if (preview.markdown) {
		try {
			const md = new Markdown(readFileSync(path, "utf8"), 0, 0, MD_THEME);
			return md.render(Math.max(10, width)).slice(0, height);
		} catch {
			return [`${DIM}(无法渲染 markdown)${RESET}`];
		}
	}
	return preview.lines.slice(0, height);
}

function renderChat(m: ReadModel, width: number, height: number): string[] {
	if (m.currentId === null || m.entries.length === 0) {
		return [`${DIM}(暂无消息——左栏选择会话后 attach 显示)${RESET}`];
	}
	const flat: string[] = [];
	for (const e of m.entries) {
		for (const line of renderEntry(e, width)) flat.push(line);
	}
	m.scroll = Math.max(0, Math.min(m.scroll, Math.max(0, flat.length - height)));
	const end = flat.length - m.scroll;
	const start = Math.max(0, end - height);
	return flat.slice(start, end);
}

function renderEntry(e: ChatEntry, width: number): string[] {
	if (e.kind === "notice") {
		return [`${DIM}${e.text}${RESET}`];
	}
	if (e.kind === "user") {
		const lines = [`${CYAN}you ▸${RESET}`];
		for (const l of wrapPlain(e.text, Math.max(8, width - 2)))
			lines.push(`  ${clipVisible(l, Math.max(8, width - 2))}`);
		return lines;
	}
	const lines: string[] = [];
	if (e.thinking !== undefined && e.thinking !== null && e.thinking.length > 0) {
		const tok = Math.ceil(e.thinking.length / 4);
		lines.push(`${DIM}▸ 思考 (${tok} tok)${RESET}`);
	}
	if (e.text.length > 0) {
		const md = new Markdown(e.text, 0, 0, MD_THEME);
		for (const l of md.render(Math.max(10, width - 1))) lines.push(l);
	}
	return lines;
}

// —— 右栏 ——

function renderRight(m: ReadModel, width: number, height: number): string[] {
	const inner = Math.max(6, width - 2);
	const cur = m.sessions.find((x) => x.sessionId === m.currentId);
	const lines: string[] = [
		`${BOLD}TODOLIST${RESET}`,
		`${DIM}(M6 接入 todolist 扩展)${RESET}`,
		"",
		`${DIM}── session ──${RESET}`,
	];
	if (cur !== undefined) {
		lines.push(
			` id     ${short(cur.sessionId)}`,
			` status ${statusDot(cur)} ${cur.status}${cur.processing ? " ⋙" : ""}`,
			` attach ${cur.attached}`,
			` tokens ${fmtTokens(cur)}`,
			` cost   $${cur.costUsd.toFixed(2)}`,
		);
	} else {
		lines.push(`${DIM} (未选择)${RESET}`);
	}
	if (m.task !== null) {
		lines.push("", `${DIM}── goal ──${RESET}`);
		lines.push(` ${BOLD}${m.task.phase}${RESET} v${m.task.contractRevision}${m.task.pendingChanges ? " ⚠变更" : ""}`);
		for (const d of m.task.deliverables.slice(0, 8)) {
			lines.push(` ${deliverableDot(d.status)} ${d.id} ${clipVisible(d.name, inner - 8)}`);
		}
	}
	if (m.inputMode) {
		lines.push("", `${DIM}── input ──${RESET}`, `${CYAN}▸ 输入模式${RESET}`, `${DIM}Esc 返回导航${RESET}`);
	}
	return lines.map((l) => clipVisible(l, inner)).slice(0, height);
}

// —— 输入区（§5.4）——

function renderSwarmBar(m: ReadModel, width: number): string[] {
	if (m.swarm.cells.length === 0) return [];
	const chips = m.swarm.cells
		.slice(0, 8)
		.map((c, i) => {
			const selected = c.cellId === m.swarm.selectedCellId;
			const label = `${i + 1} ${c.role} ${cellDot(c.status)}`;
			return selected ? `${REVERSE}${label}${RESET}` : label;
		})
		.join(" ");
	const main = m.swarm.selectedCellId === null ? `${REVERSE}main${RESET}` : "main";
	return [clipVisible(`${main} ${DIM}│${RESET} ${chips}`, width)];
}

function renderInputArea(input: InputAreaState, width: number): string[] {
	const lines: string[] = [];
	if (input.completion !== null) {
		for (const l of renderCompletionPopup(input.completion, width)) lines.push(`${DIM}${l}${RESET}`);
	}
	const editorLines = input.editor.renderLines(width);
	for (let i = 0; i < editorLines.length; i++) {
		const l = editorLines[i] ?? "";
		lines.push(i === 0 ? `${CYAN}❯${RESET}${l}` : `  ${l}`);
	}
	return lines.slice(0, 5);
}

function renderFooter(m: ReadModel, hint: string, width: number): string {
	const total = m.totals.input + m.totals.output;
	const mode = m.inputMode ? `${CYAN}[输入]${RESET}` : `${DIM}[导航]${RESET}`;
	const keys = m.inputMode
		? "Enter 发送 · \\+Enter/Alt+Enter 换行 · Tab 补全 · Esc 退出输入"
		: "q 退出 · j/k 滚动 · i 输入 · t 切左栏 · [/] 切标签 · x 关标签 · Tab 下一会话";
	const line = ` ${mode} ${DIM}${keys} · Σ ${fmt(total)} tok / $${m.totals.costUsd.toFixed(2)}${hint.length > 0 ? ` · ${hint}` : ""}${RESET}`;
	return clipVisible(line, width);
}

// —— 工具 ——

export function padVisible(line: string, width: number): string {
	const vw = visibleWidth(line);
	if (vw >= width) return line;
	return line + " ".repeat(width - vw);
}

export function clipVisible(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = "";
	for (const ch of line) {
		if (visibleWidth(out + ch) > width - 1) break;
		out += ch;
	}
	return out.endsWith(RESET) ? `${out}…` : `${out}${RESET}…`;
}

function wrapPlain(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (para.length <= width) {
			out.push(para);
			continue;
		}
		let cur = "";
		for (const ch of para) {
			if (cur.length >= width - 1) {
				out.push(cur);
				cur = "";
			}
			cur += ch;
		}
		if (cur.length > 0) out.push(cur);
	}
	return out.length > 0 ? out : [""];
}

function short(id: string | null): string {
	return id === null ? "—" : id.slice(0, 8);
}

function fmtTokens(s: SessionRow): string {
	return fmt(s.tokens.input + s.tokens.output);
}

function fmt(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}
