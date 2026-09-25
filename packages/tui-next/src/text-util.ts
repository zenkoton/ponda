/**
 * 文本度量：字素迭代、终端列宽（CJK 记 2、组合符记 0）、按宽换行。
 * 元素树的 text 均为纯文本（样式由绘制层注入），这里不需要 ANSI 处理。
 */

const COMBINING = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/;
const WIDE_NON_BMP =
	/[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF]|\uFE0F/;

const WIDE_BMP_RANGES: readonly (readonly [number, number])[] = [
	[0x1100, 0x115f],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
];

export function charWidth(ch: string): number {
	if (ZERO_WIDTH.test(ch)) return 0;
	if (COMBINING.test(ch)) return 0;
	const code = ch.codePointAt(0) ?? 0;
	if (code > 0xffff) return WIDE_NON_BMP.test(ch) ? 2 : 1;
	for (const [lo, hi] of WIDE_BMP_RANGES) {
		if (code >= lo && code <= hi) return 2;
	}
	return 1;
}

export interface Grapheme {
	ch: string;
	width: number;
}

/** 最小字素聚类：基字符 + 组合符/变体选择符；ZWJ 连接 emoji 序列 */
export function graphemes(s: string): Grapheme[] {
	const chars = [...s];
	const out: Grapheme[] = [];
	let i = 0;
	while (i < chars.length) {
		let cluster = chars[i++] ?? "";
		while (i < chars.length && (COMBINING.test(chars[i] ?? "") || chars[i] === "\uFE0F")) {
			cluster += chars[i++];
		}
		while (chars[i] === "\u200D" && i + 1 < chars.length) {
			cluster += chars[i++];
			cluster += chars[i++];
			while (i < chars.length && (COMBINING.test(chars[i] ?? "") || chars[i] === "\uFE0F")) {
				cluster += chars[i++];
			}
		}
		out.push({ ch: cluster, width: clusterWidth(cluster) });
	}
	return out;
}

function clusterWidth(cluster: string): number {
	let w = 0;
	for (const ch of [...cluster]) w += charWidth(ch);
	return w;
}

export function visibleWidth(s: string): number {
	let w = 0;
	for (const g of graphemes(s)) w += g.width;
	return w;
}

/** 贪心换行：优先空格断行，超长词硬拆；返回的行可见宽度 ≤ width（width ≥ 1） */
export function wrapText(s: string, width: number): string[] {
	const maxWidth = Math.max(1, width);
	const lines: string[] = [];
	for (const logical of s.split("\n")) {
		if (logical.length === 0) {
			lines.push("");
			continue;
		}
		let current: Grapheme[] = [];
		let currentWidth = 0;
		for (const g of graphemes(logical)) {
			if (g.width > 0 && currentWidth + g.width > maxWidth) {
				const cut = lastSpaceIndex(current);
				if (cut > 0) {
					lines.push(joinGraphemes(current.slice(0, cut)));
					current = current.slice(cut + 1);
					currentWidth = current.reduce((a, x) => a + x.width, 0);
				} else {
					lines.push(joinGraphemes(current));
					current = [];
					currentWidth = 0;
				}
				if (g.width > maxWidth) continue;
			}
			current.push(g);
			currentWidth += g.width;
		}
		lines.push(joinGraphemes(current));
	}
	return lines.length > 0 ? lines : [""];
}

function lastSpaceIndex(gs: Grapheme[]): number {
	for (let i = gs.length - 1; i >= 0; i--) {
		if (gs[i]?.ch === " ") return i;
	}
	return -1;
}

function joinGraphemes(gs: Grapheme[]): string {
	return gs.map((g) => g.ch).join("");
}

export interface SpanLike {
	text: string;
	style?: unknown;
}

/** 富文本流式换行：跨段贪心断行（空格优先），行内相邻同源段合并 */
export function wrapSpans<T extends SpanLike>(spans: T[], width: number): T[][] {
	const maxWidth = Math.max(1, width);
	const lines: T[][] = [];
	let current: { g: Grapheme; span: T }[] = [];
	let currentWidth = 0;
	const pushLine = (): void => {
		while (current.length > 0 && current[current.length - 1]?.g.ch === " ") current.pop();
		const segments: T[] = [];
		for (const { g, span } of current) {
			const last = segments[segments.length - 1];
			if (last !== undefined && last.style === span.style) {
				last.text += g.ch;
			} else {
				segments.push({ ...span, text: g.ch });
			}
		}
		lines.push(segments);
		current = [];
		currentWidth = 0;
	};
	for (const span of spans) {
		const pieces = span.text.split("\n");
		for (let p = 0; p < pieces.length; p++) {
			if (p > 0) pushLine();
			const piece = pieces[p] ?? "";
			for (const g of graphemes(piece)) {
				if (g.width > 0 && currentWidth + g.width > maxWidth) {
					let cut = -1;
					for (let i = current.length - 1; i >= 0; i--) {
						if (current[i]?.g.ch === " ") {
							cut = i;
							break;
						}
					}
					if (cut > 0) {
						const head = current.slice(0, cut);
						const tail = current.slice(cut + 1);
						current = head;
						pushLine();
						current = tail;
						currentWidth = tail.reduce((a, x) => a + x.g.width, 0);
					} else {
						pushLine();
					}
					if (g.width > maxWidth) continue;
				}
				current.push({ g, span });
				currentWidth += g.width;
			}
		}
	}
	pushLine();
	return lines;
}
