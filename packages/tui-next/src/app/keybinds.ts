/**
 * 键位与命令层（opencode 范式）：绑定表为数据 → 命令；模式 = input（默认焦点）/nav。
 *
 * - input 模式（默认）：直接打字即输入；Enter 发送；Esc 进入导航；ctrl+x 为 leader
 *   前缀（输入中也能滚动/切会话，对齐 opencode 的 ctrl+x 体系）；ctrl+c 恒退出。
 * - nav 模式（Esc）：单键导航（旧键位全集保留）；任意可打印字符回到输入并插入。
 * - 弹窗优先于一切模式。
 */

import { Keymap, type ParsedKey, parseKey } from "../keys.ts";
import { computeCompletion } from "./completion.ts";
import { listFileCandidates, scanTree } from "./files.ts";
import { closeTab, cycleTab, openFileTab, pickNextSession, type TuiState } from "./state.ts";

export type InputCommand =
	| "app.quit"
	| "chat.scroll-down"
	| "chat.scroll-up"
	| "sidebar.cycle"
	| "sidebar.page"
	| "tabs.next"
	| "tabs.prev"
	| "tabs.close"
	| "session.next"
	| "session.cycle-mode"
	| "session.cycle-thinking"
	| "files.open-selected"
	| "input.enter"
	| "swarm.back-to-main"
	| "swarm.cell-1"
	| "swarm.cell-2"
	| "swarm.cell-3"
	| "swarm.cell-4"
	| "swarm.cell-5"
	| "swarm.cell-6"
	| "swarm.cell-7"
	| "swarm.cell-8"
	| "swarm.cell-9"
	| "editor.up"
	| "editor.down"
	| "editor.left"
	| "editor.right"
	| "editor.newline"
	| "editor.submit"
	| "completion.accept"
	| "editor.backspace"
	| "input.exit";

const NAV_BINDINGS: Record<string, InputCommand> = {
	q: "app.quit",
	"ctrl+c": "app.quit",
	j: "chat.scroll-down",
	down: "chat.scroll-down",
	k: "chat.scroll-up",
	up: "chat.scroll-up",
	t: "sidebar.cycle",
	"]": "tabs.next",
	"[": "tabs.prev",
	x: "tabs.close",
	tab: "session.next",
	p: "session.cycle-mode",
	enter: "files.open-selected",
	i: "input.enter",
	m: "swarm.back-to-main",
	"1": "swarm.cell-1",
	"2": "swarm.cell-2",
	"3": "swarm.cell-3",
	"4": "swarm.cell-4",
	"5": "swarm.cell-5",
	"6": "swarm.cell-6",
	"7": "swarm.cell-7",
	"8": "swarm.cell-8",
	"9": "swarm.cell-9",
};

const INPUT_BINDINGS: Record<string, InputCommand> = {
	up: "editor.up",
	down: "editor.down",
	left: "editor.left",
	right: "editor.right",
	"alt+enter": "editor.newline",
	enter: "editor.submit",
	tab: "completion.accept",
	backspace: "editor.backspace",
	esc: "input.exit",
	"ctrl+c": "app.quit",
};

/** leader（ctrl+x）后的单键：输入中也可用的导航命令（opencode 默认 leader 同为 ctrl+x） */
const LEADER_BINDINGS: Record<string, InputCommand> = {
	q: "app.quit",
	"ctrl+t": "session.cycle-thinking",
	j: "chat.scroll-down",
	down: "chat.scroll-down",
	k: "chat.scroll-up",
	up: "chat.scroll-up",
	s: "sidebar.cycle",
	t: "sidebar.page",
	x: "tabs.close",
	"]": "tabs.next",
	"[": "tabs.prev",
	tab: "session.next",
	p: "session.cycle-mode",
	m: "swarm.back-to-main",
	"1": "swarm.cell-1",
	"2": "swarm.cell-2",
	"3": "swarm.cell-3",
	"4": "swarm.cell-4",
	"5": "swarm.cell-5",
	"6": "swarm.cell-6",
	"7": "swarm.cell-7",
	"8": "swarm.cell-8",
	"9": "swarm.cell-9",
};

/** 命令执行所需的副作用（RPC 侧逻辑在 app.ts） */
export interface InputDeps {
	quit(): void;
	attach(sessionId: string): void;
	/** 权限模式循环 plan→approve→full-auto（03 §7.3；^x p / 导航 p） */
	cycleMode(): void;
	/** 思考强度循环 off→low→medium→high（04 §5.4 Ctrl-T） */
	cycleThinking(): void;
	detach(sessionId: string): void;
	send(): void;
	confirmContract(taskId: string): void;
	replanContract(taskId: string): void;
	approveChange(taskId: string, accept: boolean): void;
	respondPermission(requestId: string, approved: boolean, scope: "once" | "session" | "env-always"): void;
	mergeApply(): void;
	mergeDiscard(): void;
}

export function createInputDispatcher(state: TuiState, deps: InputDeps): (data: string) => void {
	const keymap = new Keymap<InputCommand>();
	keymap.setBindings("nav", NAV_BINDINGS);
	keymap.setBindings("input", INPUT_BINDINGS);
	let leaderArmed = false;
	return (data: string): void => {
		const key = parseKey(data);
		if (key === null) return;
		if (state.dialog() !== null) {
			dialogKey(state, deps, key);
			return;
		}
		// leader：ctrl+x 后的下一个键按导航命令解释（单发，任何模式可用）
		if (leaderArmed) {
			leaderArmed = false;
			const command = LEADER_BINDINGS[key.name] ?? LEADER_BINDINGS[key.char ?? ""];
			if (command !== undefined) runCommand(command, state, deps, key);
			return;
		}
		if (key.name === "ctrl+x") {
			leaderArmed = true;
			return;
		}
		// input/nav 互斥模式：每次重建单层栈，杜绝跨层绑定穿透
		keymap.clearModes();
		keymap.pushMode(state.mode() === "input" ? "input" : "nav");
		const command = keymap.dispatch(key);
		if (command !== null) {
			runCommand(command, state, deps, key);
			return;
		}
		if (state.mode() === "input") {
			fallbackChar(state, key);
			return;
		}
		// nav 模式下的可打印字符：回到输入模式并插入
		if (key.name === "char" || key.name === "paste") {
			state.setMode("input");
			fallbackChar(state, key);
		}
	};
}

function fallbackChar(state: TuiState, key: ParsedKey): void {
	if (key.name !== "char" && key.name !== "paste") return;
	state.editor.insertText(key.char ?? "");
	recomputeCompletion(state);
	state.bumpEditor();
}

function runCommand(command: InputCommand, state: TuiState, deps: InputDeps, key: ParsedKey): void {
	const editor = state.editor;
	switch (command) {
		case "app.quit":
			deps.quit();
			return;
		case "chat.scroll-down":
			if (state.sidebarVisible() && state.leftTab() === "files") state.moveTreeCursor(1);
			else state.scrollBy(3);
			return;
		case "chat.scroll-up":
			if (state.sidebarVisible() && state.leftTab() === "files") state.moveTreeCursor(-1);
			else state.scrollBy(-3);
			return;
		case "sidebar.cycle":
			state.cycleSidebar();
			return;
		case "sidebar.page":
			state.toggleLeftTab();
			return;
		case "tabs.next":
			state.setActiveTabId(cycleTab(state.tabs(), state.activeTabId(), 1));
			return;
		case "tabs.prev":
			state.setActiveTabId(cycleTab(state.tabs(), state.activeTabId(), -1));
			return;
		case "tabs.close": {
			const closed = closeTab(state.tabs(), state.activeTabId(), state.activeTabId());
			state.setTabs(closed.tabs);
			state.setActiveTabId(closed.activeId);
			return;
		}
		case "session.next": {
			const next = pickNextSession(state.sessions(), state.currentId());
			if (next !== null && next !== state.currentId()) {
				const prev = state.currentId();
				if (prev !== null) deps.detach(prev);
				deps.attach(next);
			}
			return;
		}
		case "session.cycle-mode":
			deps.cycleMode();
			return;
		case "session.cycle-thinking":
			deps.cycleThinking();
			return;
		case "files.open-selected":
			openSelectedFile(state);
			return;
		case "input.enter":
			state.setMode("input");
			return;
		case "swarm.back-to-main": {
			const swarm = state.swarm();
			if (swarm.selectedCellId === null) return;
			state.setSwarm({ ...swarm, selectedCellId: null });
			const main = swarm.mainSessionId;
			if (main !== null && main !== state.currentId()) deps.attach(main);
			return;
		}
		case "swarm.cell-1":
		case "swarm.cell-2":
		case "swarm.cell-3":
		case "swarm.cell-4":
		case "swarm.cell-5":
		case "swarm.cell-6":
		case "swarm.cell-7":
		case "swarm.cell-8":
		case "swarm.cell-9": {
			const idx = Number(command.slice(-1)) - 1;
			const swarm = state.swarm();
			const cell = swarm.cells[idx];
			if (cell === undefined) return;
			state.setSwarm({
				...swarm,
				selectedCellId: cell.cellId,
				mainSessionId: swarm.mainSessionId ?? state.currentId(),
			});
			if (cell.sessionId !== state.currentId()) deps.attach(cell.sessionId);
			return;
		}
		case "editor.up":
			if (state.completion() !== null) moveCompletion(state, -1);
			else {
				editor.up();
				state.bumpEditor();
			}
			return;
		case "editor.down":
			if (state.completion() !== null) moveCompletion(state, 1);
			else {
				editor.down();
				state.bumpEditor();
			}
			return;
		case "editor.left":
			editor.left();
			state.bumpEditor();
			return;
		case "editor.right":
			editor.right();
			state.bumpEditor();
			return;
		case "editor.newline":
			editor.newline();
			recomputeCompletion(state);
			state.bumpEditor();
			return;
		case "editor.submit": {
			const completion = state.completion();
			if (completion !== null) {
				// 命令已完整输入（token 与选中候选一致）→ 直接发送，不吞掉这次 Enter
				const token = state.editor.currentToken()?.token ?? "";
				const selected = completion.candidates[completion.selected];
				if (completion.kind === "/" && token === selected) {
					state.setCompletion(null);
					deps.send();
					return;
				}
				acceptCompletion(state);
				return;
			}
			deps.send();
			return;
		}
		case "completion.accept":
			// 输入模式下的 Tab：有补全就接受；编辑器为空则切换会话侧栏
			if (state.completion() !== null) {
				acceptCompletion(state);
				return;
			}
			if (state.editor.isEmpty) state.cycleSidebar();
			return;
		case "editor.backspace":
			editor.backspace();
			recomputeCompletion(state);
			state.bumpEditor();
			return;
		case "input.exit":
			if (state.completion() !== null) {
				state.setCompletion(null);
				return;
			}
			state.setMode("nav");
			return;
	}
	void key;
}

function moveCompletion(state: TuiState, delta: number): void {
	const completion = state.completion();
	if (completion === null) return;
	const selected = Math.max(0, Math.min(completion.candidates.length - 1, completion.selected + delta));
	state.setCompletion({ ...completion, selected });
}

function acceptCompletion(state: TuiState): void {
	const completion = state.completion();
	if (completion === null) return;
	const value = completion.candidates[completion.selected];
	if (value !== undefined) state.editor.replaceCurrentToken(value);
	state.setCompletion(null);
	state.bumpEditor();
}

export function recomputeCompletion(state: TuiState): void {
	const token = state.editor.currentToken()?.token ?? null;
	state.setCompletion(
		computeCompletion(token, {
			files: listFileCandidates(state.fileTree().root, 200),
		}),
	);
}

function openSelectedFile(state: TuiState): void {
	const tree = state.fileTree();
	if (!state.sidebarVisible() || state.leftTab() !== "files" || tree.root === null) return;
	const nodes = scanTree(tree.root, tree.expanded);
	const n = nodes[tree.cursor];
	if (n === undefined) return;
	if (n.dir) {
		state.toggleTreeExpand(n.relPath);
		return;
	}
	const tabs = openFileTab(state.tabs(), `${tree.root}/${n.relPath}`, n.name);
	state.setTabs(tabs);
	state.setActiveTabId(`file:${tree.root}/${n.relPath}`);
}

/** 弹窗按键（按弹窗类型分发；04 §6） */
function dialogKey(state: TuiState, deps: InputDeps, key: ParsedKey): void {
	const dialog = state.dialog();
	if (dialog === null) return;
	const ch = key.char ?? "";
	if (dialog.kind === "contract") {
		if (key.name === "enter") {
			state.setDialog(null);
			deps.confirmContract(dialog.taskId);
		} else if (ch === "r") {
			state.setDialog(null);
			deps.replanContract(dialog.taskId);
		} else if (key.name === "esc") {
			state.setDialog(null);
		}
		return;
	}
	if (dialog.kind === "change") {
		if (ch === "y") {
			state.setDialog(null);
			deps.approveChange(dialog.taskId, true);
		} else if (ch === "n") {
			state.setDialog(null);
			deps.approveChange(dialog.taskId, false);
		}
		return;
	}
	if (dialog.kind === "permission") {
		const map: Record<string, { approved: boolean; scope: "once" | "session" | "env-always" }> = {
			y: { approved: true, scope: "once" },
			s: { approved: true, scope: "session" },
			a: { approved: true, scope: "env-always" },
			n: { approved: false, scope: "once" },
		};
		const answer = map[ch];
		if (answer === undefined) return;
		state.setDialog(null);
		deps.respondPermission(dialog.requestId, answer.approved, answer.scope);
		return;
	}
	// merge
	if (key.name === "enter") {
		state.setDialog(null);
		deps.mergeApply();
	} else if (ch === "d") {
		state.setDialog(null);
		deps.mergeDiscard();
	} else if (key.name === "esc") {
		state.setDialog(null);
	}
}
