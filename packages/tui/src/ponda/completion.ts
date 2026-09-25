/**
 * @文件引用 与 /命令 补全（design: 04-tui.md §5.4；M5 第二批）。
 */
export interface SlashCommandInfo {
	name: string;
	description: string;
}

export interface CompletionState {
	kind: "@" | "/";
	query: string;
	candidates: string[];
	selected: number;
}

/** 内置 / 命令（ponda 注入；pi 原生命令在 P1 接入后合并） */
export const SLASH_COMMANDS: SlashCommandInfo[] = [
	{ name: "/help", description: "帮助" },
	{ name: "/compact", description: "压缩上下文" },
	{ name: "/mode", description: "切换权限模式" },
	{ name: "/goal", description: "启动 goal 任务（M6）" },
	{ name: "/wiki-rebuild", description: "重建 .wiki（M9）" },
	{ name: "/skill", description: "强制加载 skill" },
	{ name: "/mcp", description: "MCP 面板" },
];

/** 子序列模糊匹配（@/ 补全体量小，够用） */
function fuzzyMatch(query: string, target: string): boolean {
	let qi = 0;
	for (let ti = 0; ti < target.length && qi < query.length; ti++) {
		if (target[ti] === query[qi]) qi++;
	}
	return qi === query.length;
}

export function computeCompletion(
	token: string | null,
	sources: { files: string[]; commands?: SlashCommandInfo[] },
): CompletionState | null {
	if (token === null || token.length < 1) return null;
	const kind = token[0];
	if (kind !== "@" && kind !== "/") return null;
	const query = token.slice(1);

	if (kind === "/") {
		const commands = sources.commands ?? SLASH_COMMANDS;
		const candidates = commands
			.filter((c) => fuzzyMatch(query, c.name.slice(1)))
			.map((c) => c.name)
			.slice(0, 8);
		if (candidates.length === 0) return null;
		return { kind, query, candidates, selected: 0 };
	}
	const candidates = sources.files.filter((f) => fuzzyMatch(query.toLowerCase(), f.toLowerCase())).slice(0, 8);
	if (candidates.length === 0) return null;
	return { kind, query, candidates, selected: 0 };
}

/** 补全弹层渲染行（输入区上方；选中项高亮由调用方加 ANSI） */
export function renderCompletionPopup(state: CompletionState, width: number): string[] {
	const hint = state.kind === "@" ? "文件" : "命令";
	const lines = state.candidates.map((c, i) => {
		const marker = i === state.selected ? "▸" : " ";
		return `${marker}${c}`;
	});
	return [`${hint}补全（Tab 选中 ↓↑ 切换 Esc 关闭）`, ...lines].map((l) =>
		l.length > width ? l.slice(0, width - 1) : l,
	);
}
