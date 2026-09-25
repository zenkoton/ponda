/**
 * 迷你 Markdown 渲染（替代 pi-tui Markdown 组件）：行级块解析 + 行内样式，
 * 输出 rich/text/box 元素供组件树使用。覆盖：标题、段落、围栏代码、引用、
 * 列表（嵌套缩进）、分割线、管道表格、行内 code/粗体/斜体/删除线/链接。
 * 主题默认对齐旧 MD_THEME（heading 粗体、链接青、行内代码黄、代码块/引用暗淡）。
 */

import { box, type Element, rich, type Span, type TextStyle, text } from "./element.ts";

export interface MdTheme {
	heading?: TextStyle;
	link?: TextStyle;
	inlineCode?: TextStyle;
	codeBlock?: TextStyle;
	quote?: TextStyle;
	bullet?: TextStyle;
	bold?: TextStyle;
	italic?: TextStyle;
	strikethrough?: TextStyle;
	tableHeader?: TextStyle;
}

export const DEFAULT_MD_THEME: MdTheme = {
	heading: { bold: true },
	link: { fg: "cyan" },
	inlineCode: { fg: "yellow" },
	codeBlock: { dim: true },
	quote: { dim: true },
	bullet: { fg: "yellow" },
	bold: { bold: true },
	strikethrough: { dim: true, strikethrough: true },
	tableHeader: { bold: true },
};

export type MdBlock =
	| { type: "heading"; level: number; text: string }
	| { type: "paragraph"; text: string }
	| { type: "code"; lines: string[]; lang?: string | null }
	| { type: "quote"; lines: string[] }
	| { type: "listItem"; depth: number; ordered: boolean; marker: string; text: string }
	| { type: "hr" }
	| { type: "table"; rows: string[][] };

export function parseMarkdown(src: string): MdBlock[] {
	const blocks: MdBlock[] = [];
	const lines = src.split("\n");
	let i = 0;
	const flushParagraph = (buffer: string[]): void => {
		if (buffer.length > 0) {
			blocks.push({ type: "paragraph", text: buffer.join(" ").trim() });
			buffer.length = 0;
		}
	};
	const paragraph: string[] = [];
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (heading !== null) {
			flushParagraph(paragraph);
			blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
			i++;
			continue;
		}
		if (/^\s*(```|~~~)/.test(line)) {
			flushParagraph(paragraph);
			const fence = line.trim()[0];
			const lang =
				line
					.trim()
					.replace(/^(```|~~~)/, "")
					.trim() || null;
			i++;
			const codeLines: string[] = [];
			while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(fence === "`" ? "```" : "~~~")) {
				codeLines.push(lines[i] ?? "");
				i++;
			}
			i++; // 跳过收尾围栏（或 EOF）
			blocks.push({ type: "code", lines: codeLines, lang });
			continue;
		}
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushParagraph(paragraph);
			blocks.push({ type: "hr" });
			i++;
			continue;
		}
		const quote = line.match(/^>\s?(.*)$/);
		if (quote !== null) {
			flushParagraph(paragraph);
			const quoteLines: string[] = [];
			while (i < lines.length) {
				const m = (lines[i] ?? "").match(/^>\s?(.*)$/);
				if (m === null) break;
				quoteLines.push(m[1] ?? "");
				i++;
			}
			blocks.push({ type: "quote", lines: quoteLines });
			continue;
		}
		const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (item !== null) {
			flushParagraph(paragraph);
			const indent = item[1] ?? "";
			blocks.push({
				type: "listItem",
				depth: Math.floor(indent.length / 2),
				ordered: /\d/.test(item[2] ?? ""),
				marker: item[2] ?? "-",
				text: item[3] ?? "",
			});
			i++;
			continue;
		}
		if (line.trim().length === 0) {
			flushParagraph(paragraph);
			i++;
			continue;
		}
		if (isTableLine(line) && isTableSeparator(lines[i + 1] ?? "")) {
			flushParagraph(paragraph);
			const rows: string[][] = [];
			while (i < lines.length && isTableLine(lines[i] ?? "")) {
				rows.push(splitTableRow(lines[i] ?? ""));
				i++;
			}
			blocks.push({ type: "table", rows });
			continue;
		}
		paragraph.push(line.trim());
		i++;
	}
	flushParagraph(paragraph);
	return blocks;
}

function isTableLine(line: string): boolean {
	const t = line.trim();
	return t.startsWith("|") && t.endsWith("|") && t.length >= 2;
}

function isTableSeparator(line: string): boolean {
	return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
}

interface InlineRule {
	re: RegExp;
	style: keyof MdTheme;
	recursive: boolean;
	group: number;
}

const INLINE_RULES: readonly InlineRule[] = [
	{ re: /`([^`]+)`/, style: "inlineCode", recursive: false, group: 1 },
	{ re: /\*\*([^*]+)\*\*/, style: "bold", recursive: true, group: 1 },
	{ re: /__([^_]+)__/, style: "bold", recursive: true, group: 1 },
	{ re: /~~([^~]+)~~/, style: "strikethrough", recursive: true, group: 1 },
	{ re: /\[([^\]]+)\]\(([^)]+)\)/, style: "link", recursive: false, group: 1 },
	{ re: /(?<!\*)\*([^*\s][^*]*)\*(?!\*)/, style: "italic", recursive: true, group: 1 },
];

/** 行内解析：code/粗体/斜体/删除线/链接 → 样式段 */
export function parseInline(src: string, base: TextStyle, theme: MdTheme): Span[] {
	const spans: Span[] = [];
	let rest = src;
	while (rest.length > 0) {
		let best: { index: number; rule: InlineRule; match: RegExpExecArray } | null = null;
		for (const rule of INLINE_RULES) {
			const m = rule.re.exec(rest);
			if (m === null) continue;
			if (best === null || m.index < best.match.index) best = { index: m.index, rule, match: m };
		}
		if (best === null) {
			spans.push({ text: rest, style: { ...base } });
			break;
		}
		const { rule, match } = best;
		if (match.index > 0) spans.push({ text: rest.slice(0, match.index), style: { ...base } });
		const inner = match[rule.group] ?? "";
		const style = mergeStyle(base, theme[rule.style]);
		if (rule.recursive) {
			spans.push(...parseInline(inner, style, theme));
		} else {
			spans.push({ text: inner, style });
		}
		rest = rest.slice(match.index + match[0].length);
	}
	return spans.filter((s) => s.text.length > 0);
}

function mergeStyle(base: TextStyle, extra: TextStyle | undefined): TextStyle {
	return extra === undefined ? { ...base } : { ...base, ...extra };
}

/** Markdown → 元素列表（放入 column box 即成文档流） */
export function markdownElements(src: string, theme: MdTheme = DEFAULT_MD_THEME): Element[] {
	const out: Element[] = [];
	for (const block of parseMarkdown(src)) {
		switch (block.type) {
			case "heading": {
				out.push(rich(parseInline(block.text, theme.heading ?? {}, theme)));
				break;
			}
			case "paragraph": {
				if (block.text.length > 0) out.push(rich(parseInline(block.text, {}, theme)));
				break;
			}
			case "code": {
				const langLabel =
					block.lang !== undefined && block.lang !== null && block.lang.length > 0
						? [text({ text: `── ${block.lang} ──`, dim: true })]
						: [];
				out.push(
					box({ paddingLeft: 1 }, [
						...langLabel,
						...block.lines.map((line) => text({ text: line.length > 0 ? line : " ", ...theme.codeBlock })),
					]),
				);
				break;
			}
			case "quote": {
				out.push(
					box(
						{ paddingLeft: 1 },
						block.lines.map((line) => rich(parseInline(line.length > 0 ? line : " ", theme.quote ?? {}, theme))),
					),
				);
				break;
			}
			case "listItem": {
				const markerSpan: Span = { text: `${block.marker} `, style: { ...theme.bullet } };
				out.push(
					box({ paddingLeft: block.depth * 2 }, [rich([markerSpan, ...parseInline(block.text, {}, theme)])]),
				);
				break;
			}
			case "hr": {
				out.push(text({ text: "─".repeat(40), dim: true }));
				break;
			}
			case "table": {
				out.push(...tableElements(block.rows, theme));
				break;
			}
		}
	}
	return out;
}

function tableElements(rows: string[][], theme: MdTheme): Element[] {
	if (rows.length === 0) return [];
	const columnCount = rows.reduce((a, r) => Math.max(a, r.length), 0);
	const widths: number[] = [];
	for (let c = 0; c < columnCount; c++) {
		widths.push(Math.max(1, ...rows.map((r) => (r[c] ?? "").length + 2)));
	}
	const out: Element[] = [];
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri];
		if (row === undefined) continue;
		if (ri === 1 && row.every((cell) => /^:?-+:?$/.test(cell))) continue; // 分隔行
		const spans: Span[] = [];
		const base = ri === 0 ? (theme.tableHeader ?? {}) : {};
		for (let c = 0; c < columnCount; c++) {
			const cell = row[c] ?? "";
			spans.push({ text: ` ${(cell).padEnd(widths[c] ?? 1)} `, style: { ...base } });
		}
		out.push(rich(spans));
		if (ri === 0) out.push(text({ text: widths.map((w) => "─".repeat(w)).join(""), dim: true }));
	}
	return out;
}
