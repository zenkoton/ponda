/**
 * flexbox 布局引擎（opencode/OpenTUI 的 Yoga 布局在 TS 侧的自研子集）。
 * 整数单元格、确定性分配：正剩余空间按 grow 比例分配（余数按子序补 1），
 * 溢出按 shrink×basis 加权收缩（受 min 约束，钳不住则绘制层裁剪）。
 */

import {
	type BoxElement,
	type Element,
	type ModalElement,
	normalizeChildren,
	type RichTextElement,
	type ScrollElement,
	type Size,
	type Span,
	type TextElement,
} from "./element.ts";
import { visibleWidth, wrapSpans, wrapText } from "./text-util.ts";

export interface LaidText {
	segments: Span[];
}

export interface LaidNode {
	el: Element;
	/** 相对父内容区原点的位置 */
	x: number;
	y: number;
	w: number;
	h: number;
	textLines?: LaidText[];
	children?: LaidNode[];
	/** scroll 视口的内容起始行（内容坐标 → 视口平移量） */
	windowStart?: number;
	/** scroll 视口的内容总高（供滚动钳制参考） */
	contentHeight?: number;
}

export function layout(el: Element, availWidth: number, availHeight?: number): LaidNode {
	if (el.kind === "text") return layoutText(el, availWidth, availHeight);
	if (el.kind === "rich") return layoutRich(el, availWidth, availHeight);
	if (el.kind === "modal") return layoutModal(el);
	if (el.kind === "scroll") return layoutScroll(el, availWidth, availHeight);
	return layoutBox(el, availWidth, availHeight);
}

function layoutText(el: TextElement, availWidth: number, availHeight?: number): LaidNode {
	const width = Math.max(1, availWidth);
	const lines = wrapText(el.text, width);
	const { kind: _kind, text: _text, ...style } = el;
	const height = availHeight ?? lines.length;
	const maxWidth = lines.reduce((a, l) => Math.max(a, visibleWidth(l)), 0);
	return {
		el,
		x: 0,
		y: 0,
		w: Math.min(width, Math.max(1, maxWidth)),
		h: Math.max(1, height),
		textLines: lines.map((line) => ({ segments: [{ text: line, style }] })),
	};
}

function layoutRich(el: RichTextElement, availWidth: number, availHeight?: number): LaidNode {
	const width = Math.max(1, availWidth);
	const lines = wrapSpans(el.spans, width);
	const height = availHeight ?? Math.max(1, lines.length);
	const maxWidth = lines.reduce((a, segs) => Math.max(a, segmentsWidth(segs)), 0);
	return {
		el,
		x: 0,
		y: 0,
		w: Math.min(width, Math.max(1, maxWidth)),
		h: Math.max(1, height),
		textLines: lines.map((segments) => ({ segments })),
	};
}

function segmentsWidth(segments: Span[]): number {
	return segments.reduce((a, seg) => a + visibleWidth(seg.text), 0);
}

interface Frame {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

function resolveFrame(el: BoxElement | ModalElement): Frame {
	const opts = typeof el.border === "object" && el.border !== null ? el.border : undefined;
	const borderOn = el.border === true || opts !== undefined;
	const sides = opts?.sides;
	const side = (side: "left" | "right" | "top" | "bottom"): number =>
		borderOn && (sides === undefined || sides.includes(side)) ? 1 : 0;
	const p = el.padding ?? 0;
	return {
		top: side("top") + (el.paddingTop ?? p),
		right: side("right") + (el.paddingRight ?? p),
		bottom: side("bottom") + (el.paddingBottom ?? p),
		left: side("left") + (el.paddingLeft ?? p),
	};
}

export function resolveSize(size: Size | undefined, avail: number): number | undefined {
	if (size === undefined) return undefined;
	if (typeof size === "number") return size;
	const percent = Number.parseFloat(size);
	return Math.floor((avail * percent) / 100);
}

function layoutBox(el: BoxElement, availWidth: number, availHeight?: number): LaidNode {
	const frame = resolveFrame(el);
	const outerW = Math.max(frame.left + frame.right + 1, availWidth);
	const contentW = Math.max(1, outerW - frame.left - frame.right);
	const contentH = availHeight !== undefined ? Math.max(1, availHeight - frame.top - frame.bottom) : undefined;
	const direction = el.flexDirection ?? "column";
	const gap = el.gap ?? 0;
	// modal 不参与常规流（renderTree 在基础帧之上居中合成）
	const children = normalizeChildren(el.children).filter((c) => c.kind !== "modal");
	const childNodes: LaidNode[] = [];

	if (direction === "column") {
		// 主轴（高度）：显式 > auto 实测；交叉轴默认 stretch 到内容宽
		const measured: number[] = children.map((child) => {
			const box = child.kind === "box" ? child : null;
			if (box?.height !== undefined && contentH !== undefined) {
				return resolveSize(box.height, contentH) ?? 1;
			}
			const childW = childWidth(child, contentW);
			return layout(child, childW, undefined).h;
		});
		const sizes = allocateMain(children, measured, contentH, gap, "height");
		const total = sizes.reduce((a, s) => a + s, 0) + gap * Math.max(0, children.length - 1);
		let y = justifyOffset(el.justify, contentH ?? total, total);
		for (let i = 0; i < children.length; i++) {
			const child = children[i];
			if (child === undefined) continue;
			const node = layout(child, childWidth(child, contentW), sizes[i] ?? 1);
			node.x = alignOffset(el.align, contentW ?? node.w, node.w);
			node.y = y;
			childNodes.push(node);
			y += (sizes[i] ?? 1) + gap;
		}
		const boxH = (contentH ?? total) + frame.top + frame.bottom;
		return { el, x: 0, y: 0, w: outerW, h: Math.max(1, boxH), children: childNodes };
	}

	// row：主轴（宽度）：显式 > auto 自然宽；再定高（显式 > stretch > 自然）
	const widths: number[] = children.map((child) => {
		const box = child.kind === "box" ? child : null;
		const explicit = resolveSize(box?.width, contentW);
		return explicit ?? naturalWidth(child, contentW);
	});
	const sizes = allocateMain(children, widths, contentW, gap, "width");
	const rowH =
		contentH ??
		sizes.reduce((a, size, i) => {
			const child = children[i];
			if (child === undefined) return a;
			return Math.max(a, layout(child, size, undefined).h);
		}, 0);
	const contentTotal = sizes.reduce((a, s) => a + s, 0);
	const spacing = Math.max(gap, gapBetween(el.justify, contentW, contentTotal, children.length));
	const total = contentTotal + spacing * Math.max(0, children.length - 1);
	let x = justifyOffset(el.justify, contentW, total);
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child === undefined) continue;
		const box = child.kind === "box" ? child : null;
		let h: number | undefined;
		if (box?.height !== undefined && contentH !== undefined) h = resolveSize(box.height, contentH) ?? 1;
		else if (contentH !== undefined && (el.align ?? "stretch") === "stretch") h = contentH;
		const node = layout(child, sizes[i] ?? 1, h);
		node.x = x;
		node.y = alignOffset(el.align, rowH, node.h);
		childNodes.push(node);
		x += (sizes[i] ?? 1) + spacing;
	}
	return { el, x: 0, y: 0, w: outerW, h: Math.max(1, rowH + frame.top + frame.bottom), children: childNodes };
}

function childWidth(child: Element, contentW: number): number {
	// 交叉轴默认 stretch：显式宽（含百分比 + min/max 钳制）优先，否则铺满内容宽。
	// row 主轴的 auto 宽测量走 naturalWidth（allocateMain），不经此处。
	if (child.kind === "box") {
		const explicit = resolveSize(child.width, contentW);
		if (explicit !== undefined) return clampWidth(child, explicit);
		return clampWidth(child, contentW);
	}
	return contentW;
}

function clampWidth(el: BoxElement, w: number): number {
	return Math.min(Math.max(w, el.minWidth ?? 0), el.maxWidth ?? Number.POSITIVE_INFINITY);
}

/** scroll 视口：子内容按内容宽无限高测量；offset 为距底部行数，显示时向上平移 */
function layoutScroll(el: ScrollElement, availWidth: number, availHeight?: number): LaidNode {
	const children = normalizeChildren(el.children);
	const childNodes: LaidNode[] = [];
	let y = 0;
	for (const child of children) {
		const node = layout(child, childWidth(child, availWidth), undefined);
		node.y = y;
		childNodes.push(node);
		y += node.h;
	}
	const contentH = y;
	const viewportH = availHeight ?? contentH;
	const offset = Math.max(0, Math.min(el.offset(), Math.max(0, contentH - viewportH)));
	const end = contentH - offset;
	const windowStart = Math.max(0, end - viewportH);
	return {
		el,
		x: 0,
		y: 0,
		w: availWidth,
		h: viewportH,
		children: childNodes,
		windowStart,
		contentHeight: contentH,
	};
}

/** 主轴尺寸分配：basis 汇总 → 正剩余按 grow 分配 / 负剩余按 shrink×basis 收缩 */
function allocateMain(
	children: Element[],
	bases: number[],
	avail: number | undefined,
	gap: number,
	axis: "width" | "height",
): number[] {
	const sizes = bases.map((b) => Math.max(0, b));
	if (avail === undefined) return sizes;
	const growOf = (el: Element): number => (el.kind === "box" ? (el.grow ?? 0) : 0);
	const shrinkOf = (el: Element): number => (el.kind === "box" ? (el.shrink ?? 1) : 1);
	const minOf = (el: Element): number => {
		if (el.kind !== "box") return 0;
		return axis === "width" ? (el.minWidth ?? 0) : (el.minHeight ?? 0);
	};
	const maxOf = (el: Element): number => {
		if (el.kind !== "box") return Number.POSITIVE_INFINITY;
		return axis === "width" ? (el.maxWidth ?? Number.POSITIVE_INFINITY) : (el.maxHeight ?? Infinity);
	};
	const gaps = gap * Math.max(0, children.length - 1);
	const free = avail - gaps - sizes.reduce((a, s) => a + s, 0);
	if (free > 0) {
		const totalGrow = children.reduce((a, c) => a + growOf(c), 0);
		if (totalGrow > 0) {
			let distributed = 0;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (child === undefined) continue;
				const share = Math.floor((free * growOf(child)) / totalGrow);
				sizes[i] = (sizes[i] ?? 0) + share;
				distributed += share;
			}
			let leftover = free - distributed;
			let seq = 0;
			while (leftover > 0) {
				const child = children[seq % children.length];
				if (child !== undefined && growOf(child) > 0) {
					sizes[seq % children.length] = (sizes[seq % children.length] ?? 0) + 1;
					leftover--;
				}
				seq++;
				if (seq > 100000) break;
			}
		}
	} else if (free < 0) {
		const deficit = -free;
		const totalWeight = children.reduce((a, c, i) => a + shrinkOf(c) * (sizes[i] ?? 0), 0);
		if (totalWeight > 0) {
			let shrunk = 0;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				if (child === undefined) continue;
				const cut = Math.floor((deficit * shrinkOf(child) * (sizes[i] ?? 0)) / totalWeight);
				const target = Math.max(minOf(child), (sizes[i] ?? 0) - cut);
				shrunk += (sizes[i] ?? 0) - target;
				sizes[i] = target;
			}
			let remaining = deficit - shrunk;
			let seq = 0;
			while (remaining > 0) {
				const child = children[seq % children.length];
				const i = seq % children.length;
				if (child !== undefined && shrinkOf(child) > 0 && (sizes[i] ?? 0) > minOf(child)) {
					sizes[i] = (sizes[i] ?? 0) - 1;
					remaining--;
				}
				seq++;
				if (seq > 100000) break;
			}
		}
	}
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (child === undefined) continue;
		const min = minOf(child);
		const max = maxOf(child);
		sizes[i] = Math.min(Math.max(sizes[i] ?? 0, min), max);
	}
	return sizes;
}

function justifyOffset(
	justify: "start" | "center" | "end" | "spaceBetween" | undefined,
	avail: number,
	total: number,
): number {
	if (total >= avail) return 0;
	if (justify === "center") return Math.floor((avail - total) / 2);
	if (justify === "end") return avail - total;
	return 0; // start / spaceBetween（后者由 gapBetween 补足分布）
}

/** spaceBetween：子元素间的分布间距（余量均分给间隙） */
function gapBetween(
	justify: "start" | "center" | "end" | "spaceBetween" | undefined,
	avail: number,
	total: number,
	count: number,
): number {
	if (justify !== "spaceBetween" || count <= 1) return 0;
	return Math.max(0, Math.floor((avail - total) / (count - 1)));
}

function alignOffset(align: "stretch" | "start" | "center" | "end" | undefined, avail: number, size: number): number {
	if (align === "center") return Math.max(0, Math.floor((avail - size) / 2));
	if (align === "end") return Math.max(0, avail - size);
	return 0;
}

/** 文本自然宽（单行偏好，封顶 avail）；box 自然宽 = 内容需求 + 边框留白 */
function naturalWidth(el: Element, avail: number): number {
	if (el.kind === "text") return Math.min(avail, Math.max(1, visibleWidth(el.text)));
	if (el.kind === "rich") return Math.min(avail, Math.max(1, segmentsWidth(el.spans)));
	if (el.kind === "modal") return Math.min(avail, el.width);
	if (el.kind === "scroll") {
		let w = 1;
		for (const child of normalizeChildren(el.children)) {
			w = Math.max(w, naturalWidth(child, avail));
		}
		return Math.min(avail, w);
	}
	const frame = resolveFrame(el);
	const contentW = Math.max(1, avail - frame.left - frame.right);
	const children = normalizeChildren(el.children).filter((c) => c.kind !== "modal");
	const direction = el.flexDirection ?? "column";
	let w = 1;
	for (const child of children) {
		const childW = naturalWidth(child, contentW);
		if (direction === "row") w += childW;
		else w = Math.max(w, childW);
	}
	if (direction === "row") w += (el.gap ?? 0) * Math.max(0, children.length - 1);
	return Math.min(avail, w + frame.left + frame.right);
}

/** modal 不参与常规流：固定宽测内容自然高，绘制层居中合成 */
function layoutModal(el: ModalElement): LaidNode {
	const frame = resolveFrame(el);
	const contentW = Math.max(1, el.width - frame.left - frame.right);
	const children = normalizeChildren(el.children);
	const childNodes: LaidNode[] = [];
	let y = 0;
	for (const child of children) {
		const node = layout(child, childWidth(child, contentW), undefined);
		node.y = y;
		childNodes.push(node);
		y += node.h;
	}
	const innerH = Math.min(y, el.maxHeight ?? Number.POSITIVE_INFINITY);
	return { el, x: 0, y: 0, w: el.width, h: innerH + frame.top + frame.bottom, children: childNodes };
}
