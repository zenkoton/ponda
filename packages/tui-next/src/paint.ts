/**
 * 绘制层：把布局树刷进 cell buffer，再序列化为 ANSI 行（opencode 范式的
 * OptimizedBuffer paint + 行序列化在 TS 侧的对应物）。每个单元格恰好绘制一次，
 * 天然规避 ANSI 切片/样式泄漏问题；子树按祖先矩形裁剪；modal 在基础帧之上居中合成。
 */

import type { Color, Element, TextStyle } from "./element.ts";
import { normalizeChildren } from "./element.ts";
import { type LaidNode, layout } from "./layout.ts";
import { graphemes } from "./text-util.ts";

interface Cell {
	ch: string;
	width: number;
	style: TextStyle | null;
}

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const SPACE: TextStyle | null = null;

class CellBuffer {
	readonly rows: Cell[][];
	readonly width: number;
	readonly height: number;

	constructor(width: number, height: number) {
		this.width = width;
		this.height = height;
		this.rows = [];
		for (let y = 0; y < height; y++) {
			const row: Cell[] = [];
			for (let x = 0; x < width; x++) row.push({ ch: " ", width: 1, style: SPACE });
			this.rows.push(row);
		}
	}

	put(x: number, y: number, ch: string, width: number, style: TextStyle | null, clip: Rect): void {
		if (y < clip.y0 || y >= clip.y1 || x < clip.x0 || x >= clip.x1) return;
		if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
		const row = this.rows[y];
		if (row === undefined) return;
		// 覆盖前清掉旧字素占用的续宽单元格
		let cx = x;
		while (cx < this.width && (row[cx]?.width ?? 0) === 0) {
			const cell = row[cx];
			if (cell === undefined) break;
			cell.ch = " ";
			cell.width = 1;
			cell.style = SPACE;
			cx++;
		}
		const cell = row[x];
		if (cell === undefined) return;
		cell.ch = ch;
		cell.width = width;
		cell.style = style;
		for (let i = 1; i < width && x + i < this.width; i++) {
			const cont = row[x + i];
			if (cont === undefined) break;
			cont.ch = "";
			cont.width = 0;
			cont.style = SPACE;
		}
	}

	fill(x: number, y: number, w: number, h: number, style: TextStyle | null, clip: Rect): void {
		for (let ry = Math.max(y, clip.y0); ry < Math.min(y + h, clip.y1); ry++) {
			for (let rx = Math.max(x, clip.x0); rx < Math.min(x + w, clip.x1); rx++) {
				if (ry < 0 || ry >= this.height || rx < 0 || rx >= this.width) continue;
				const cell = this.rows[ry]?.[rx];
				if (cell === undefined) continue;
				cell.ch = " ";
				cell.width = 1;
				cell.style = style;
			}
		}
	}
}

const BORDER_SINGLE = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" } as const;
const BORDER_DOUBLE = { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" } as const;
const BORDER_ROUND = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" } as const;

function intersect(a: Rect, b: Rect): Rect {
	return {
		x0: Math.max(a.x0, b.x0),
		y0: Math.max(a.y0, b.y0),
		x1: Math.min(a.x1, b.x1),
		y1: Math.min(a.y1, b.y1),
	};
}

/** 元素树 → 终端行（宽度列数 = width，高度行数 = height；modal 居中合成） */
export function renderTree(el: Element, width: number, height: number): string[] {
	const buf = new CellBuffer(width, height);
	const full: Rect = { x0: 0, y0: 0, x1: width, y1: height };
	const laid = layout(el.kind === "box" ? el : boxWrap(el), width, height);
	paintNode(buf, laid, 0, 0, full);
	if (el.kind === "box") {
		for (const child of normalizeChildren(el.children)) {
			if (child.kind !== "modal") continue;
			paintModal(buf, layout(child, width), width, height, full);
		}
	}
	return serialize(buf);
}

function boxWrap(el: Element): Element {
	return { kind: "box", children: [el] };
}

function paintNode(buf: CellBuffer, node: LaidNode, ox: number, oy: number, clip: Rect): void {
	const x = ox + node.x;
	const y = oy + node.y;
	const rect = intersect(clip, { x0: x, y0: y, x1: x + node.w, y1: y + node.h });
	if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
	if (node.el.kind === "text" || node.el.kind === "rich") {
		const lines = node.textLines ?? [];
		const rowFrom = Math.max(0, rect.y0 - y);
		const rowTo = Math.min(lines.length, node.h, rect.y1 - y);
		for (let i = rowFrom; i < rowTo; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			let col = x;
			for (const segment of line.segments) {
				const style = segment.style ?? null;
				for (const g of graphemes(segment.text)) {
					if (col >= x + node.w) break;
					buf.put(col, y + i, g.ch, g.width, style, rect);
					col += Math.max(g.width, 1);
				}
			}
		}
		return;
	}
	if (node.el.kind === "box") {
		const el = node.el;
		const style = el.backgroundColor ? { bg: el.backgroundColor } : null;
		if (style !== null) buf.fill(x, y, node.w, node.h, style, rect);
		if (el.border === true || (typeof el.border === "object" && el.border !== null)) {
			const opts = typeof el.border === "object" ? el.border : undefined;
			const borderStyle: TextStyle | null = opts?.color ? { fg: opts.color } : null;
			paintBorder(buf, x, y, node.w, node.h, opts?.style, borderStyle, rect, opts?.sides);
		}
		const padX = boxPadLeft(el);
		const padY = boxPadTop(el);
		for (const child of node.children ?? []) {
			paintNode(buf, child, x + padX, y + padY, rect);
		}
		return;
	}
	if (node.el.kind === "scroll") {
		// 内容整体上移 windowStart 行，裁剪到视口矩形
		for (const child of node.children ?? []) {
			paintNode(buf, child, x, y - (node.windowStart ?? 0), rect);
		}
	}
}

function paintModal(buf: CellBuffer, node: LaidNode, frameW: number, frameH: number, clip: Rect): void {
	const x = Math.max(0, Math.floor((frameW - node.w) / 2));
	const y = Math.max(0, Math.floor((frameH - node.h) / 2));
	const el = node.el;
	if (el.kind !== "modal") return;
	const rect = intersect(clip, { x0: x, y0: y, x1: x + node.w, y1: y + node.h });
	if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
	if (el.backgroundColor) buf.fill(x, y, node.w, node.h, { bg: el.backgroundColor }, rect);
	if (el.border === true || (typeof el.border === "object" && el.border !== null)) {
		const opts = typeof el.border === "object" ? el.border : undefined;
		paintBorder(buf, x, y, node.w, node.h, opts?.style, opts?.color ? { fg: opts.color } : null, rect, opts?.sides);
	}
	for (const child of node.children ?? []) {
		paintNode(buf, child, x + (el.padding ?? 0) + 1, y + (el.padding ?? 0) + 1, rect);
	}
}

function borderSides(el: {
	border?:
		| boolean
		| {
				style?: "single" | "double" | "round";
				color?: Color;
				sides?: readonly ("left" | "right" | "top" | "bottom")[];
		  };
}): ReadonlySet<"left" | "right" | "top" | "bottom"> | undefined {
	const opts = typeof el.border === "object" && el.border !== null ? el.border : undefined;
	if (el.border !== true && opts === undefined) return undefined;
	return opts?.sides === undefined ? undefined : new Set(opts.sides);
}

function borderOn(
	el: {
		border?:
			| boolean
			| {
					style?: "single" | "double" | "round";
					color?: Color;
					sides?: readonly ("left" | "right" | "top" | "bottom")[];
			  };
	},
	side: "left" | "right" | "top" | "bottom",
): boolean {
	if (el.border !== true && !(typeof el.border === "object" && el.border !== null)) return false;
	const sides = borderSides(el);
	return sides === undefined || sides.has(side);
}

function boxPadLeft(el: {
	border?:
		| boolean
		| {
				style?: "single" | "double" | "round";
				color?: Color;
				sides?: readonly ("left" | "right" | "top" | "bottom")[];
		  };
	padding?: number;
	paddingLeft?: number;
}): number {
	return (borderOn(el, "left") ? 1 : 0) + (el.paddingLeft ?? el.padding ?? 0);
}

function boxPadTop(el: {
	border?:
		| boolean
		| {
				style?: "single" | "double" | "round";
				color?: Color;
				sides?: readonly ("left" | "right" | "top" | "bottom")[];
		  };
	padding?: number;
	paddingTop?: number;
}): number {
	return (borderOn(el, "top") ? 1 : 0) + (el.paddingTop ?? el.padding ?? 0);
}

function paintBorder(
	buf: CellBuffer,
	x: number,
	y: number,
	w: number,
	h: number,
	style: "single" | "double" | "round" | undefined,
	borderStyle: TextStyle | null,
	clip: Rect,
	sides?: readonly ("left" | "right" | "top" | "bottom")[],
): void {
	const chars = style === "double" ? BORDER_DOUBLE : style === "round" ? BORDER_ROUND : BORDER_SINGLE;
	const right = x + w - 1;
	const bottom = y + h - 1;
	const show = (side: "left" | "right" | "top" | "bottom"): boolean => sides === undefined || sides.includes(side);
	if (show("top")) for (let cx = x; cx <= right; cx++) buf.put(cx, y, chars.h, 1, borderStyle, clip);
	if (show("bottom")) for (let cx = x; cx <= right; cx++) buf.put(cx, bottom, chars.h, 1, borderStyle, clip);
	if (show("left")) for (let cy = y; cy <= bottom; cy++) buf.put(x, cy, chars.v, 1, borderStyle, clip);
	if (show("right")) for (let cy = y; cy <= bottom; cy++) buf.put(right, cy, chars.v, 1, borderStyle, clip);
	if (show("top") && show("left")) buf.put(x, y, chars.tl, 1, borderStyle, clip);
	if (show("top") && show("right")) buf.put(right, y, chars.tr, 1, borderStyle, clip);
	if (show("bottom") && show("left")) buf.put(x, bottom, chars.bl, 1, borderStyle, clip);
	if (show("bottom") && show("right")) buf.put(right, bottom, chars.br, 1, borderStyle, clip);
}

const FG_CODES: Record<Color, number> = {
	black: 30,
	red: 31,
	green: 32,
	yellow: 33,
	blue: 34,
	magenta: 35,
	cyan: 36,
	white: 37,
	brightBlack: 90,
	brightRed: 91,
	brightGreen: 92,
	brightYellow: 93,
	brightBlue: 94,
	brightMagenta: 95,
	brightCyan: 96,
	brightWhite: 97,
};

function sgr(style: TextStyle): string {
	const codes: number[] = [];
	if (style.bold) codes.push(1);
	if (style.dim) codes.push(2);
	if (style.italic) codes.push(3);
	if (style.underline) codes.push(4);
	if (style.reverse) codes.push(7);
	if (style.strikethrough) codes.push(9);
	if (style.fg !== undefined) codes.push(FG_CODES[style.fg]);
	if (style.bg !== undefined) codes.push(FG_CODES[style.bg] + 10);
	return codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
}

function styleKey(style: TextStyle | null): string {
	if (style === null) return "";
	const parts: string[] = [];
	for (const key of Object.keys(style).sort() as (keyof TextStyle)[]) {
		parts.push(`${key}=${String(style[key])}`);
	}
	return parts.join(",");
}

function serialize(buf: CellBuffer): string[] {
	const lines: string[] = [];
	for (const row of buf.rows) {
		let out = "";
		let currentKey: string | null = null;
		let styled = false;
		for (const cell of row) {
			if (cell.width === 0) continue; // 宽字符的续宽单元格由字素自身推进光标
			const key = styleKey(cell.style);
			if (key !== currentKey) {
				if (styled) out += "\x1b[0m";
				if (key !== "") {
					out += sgr(cell.style as TextStyle);
					styled = true;
				} else {
					styled = false;
				}
				currentKey = key;
			}
			out += cell.ch;
		}
		if (styled) out += "\x1b[0m";
		lines.push(out);
	}
	return lines;
}
