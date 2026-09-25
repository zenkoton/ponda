/**
 * 声明式元素模型（opencode 范式：`<box>`/`<text>` 内建元素 + 函数组件）。
 * Node 原生 TS 无 JSX，用工厂函数替代 JSX 标签；组件即返回元素的普通函数，
 * 在渲染 effect 内求值（配合 createMemo 缓存昂贵子树）。
 *
 * 布局属性对齐 opencode/OpenTUI 的 Renderable LayoutOptions 子集：
 * flexDirection/grow/shrink/basis/width/height/percent/min/max/padding/border/gap。
 */

export type Color =
	| "black"
	| "red"
	| "green"
	| "yellow"
	| "blue"
	| "magenta"
	| "cyan"
	| "white"
	| "brightBlack"
	| "brightRed"
	| "brightGreen"
	| "brightYellow"
	| "brightBlue"
	| "brightMagenta"
	| "brightCyan"
	| "brightWhite";

export interface TextStyle {
	fg?: Color;
	bg?: Color;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	reverse?: boolean;
}

/** 百分比尺寸：相对父容器内容区（如 "28%"） */
export type Percent = `${number}%`;
export type Size = number | Percent;

export interface BorderOptions {
	style?: "single" | "double" | "round";
	color?: Color;
	/** 只画指定边（默认四边）；角仅画在两条被选边的交点 */
	sides?: readonly ("left" | "right" | "top" | "bottom")[];
}

export interface BoxProps {
	/** 主轴方向（默认 column）。 */
	flexDirection?: "row" | "column";
	grow?: number;
	shrink?: number;
	basis?: number | "auto";
	width?: Size;
	height?: Size;
	minWidth?: number;
	maxWidth?: number;
	minHeight?: number;
	maxHeight?: number;
	/** 内容区留白（不含边框） */
	padding?: number;
	paddingLeft?: number;
	paddingRight?: number;
	paddingTop?: number;
	paddingBottom?: number;
	border?: boolean | BorderOptions;
	backgroundColor?: Color;
	/** 主轴排布（默认 start）；spaceBetween 用于左右分置的页眉/页脚 */
	justify?: "start" | "center" | "end" | "spaceBetween";
	/** 交叉轴对齐（默认 stretch） */
	align?: "stretch" | "start" | "center" | "end";
	/** 主轴子元素间距 */
	gap?: number;
}

export interface TextProps extends TextStyle {
	text: string;
}

export interface TextElement extends TextProps {
	kind: "text";
}

/** 富文本段：一段带样式的文本；多段拼接后按宽度流式换行 */
export interface Span {
	text: string;
	style?: TextStyle;
}

export interface RichTextElement {
	kind: "rich";
	spans: Span[];
}

export interface BoxElement extends BoxProps {
	kind: "box";
	children: ElementChild[];
}

/** 居中覆盖层（弹窗）：铺满帧后居中绘制，不参与基础布局 */
export interface ModalElement {
	kind: "modal";
	width: number;
	maxHeight?: number;
	border?: boolean | BorderOptions;
	backgroundColor?: Color;
	padding?: number;
	paddingLeft?: number;
	paddingRight?: number;
	paddingTop?: number;
	paddingBottom?: number;
	children: ElementChild[];
}

/** 垂直滚动视口：offset 为距内容底部的行数（0 = 跟随底部），子树裁剪到视口 */
export interface ScrollElement {
	kind: "scroll";
	offset: () => number;
	children: ElementChild[];
}

export type Element = TextElement | BoxElement | ModalElement | RichTextElement | ScrollElement;
export type ElementChild = Element | string | null | undefined | false;

export function text(props: TextProps): TextElement {
	return { kind: "text", ...props };
}

export function rich(spans: Span[]): RichTextElement {
	return { kind: "rich", spans };
}

export function scroll(offset: () => number, children: ElementChild[]): ScrollElement {
	return { kind: "scroll", offset, children };
}

export function box(props: BoxProps, children: ElementChild[] = []): BoxElement {
	return { kind: "box", ...props, children };
}

export function modal(props: Omit<ModalElement, "kind" | "children">, children: ElementChild[] = []): ModalElement {
	return { kind: "modal", ...props, children };
}

export function isTextElement(el: Element): el is TextElement {
	return el.kind === "text";
}

export function isBoxElement(el: Element): el is BoxElement {
	return el.kind === "box";
}

/** 组件树构造辅助：过滤空子节点，字符串提升为纯文本元素 */
export function normalizeChildren(children: ElementChild[]): Element[] {
	const out: Element[] = [];
	for (const child of children) {
		if (child === null || child === undefined || child === false) continue;
		if (typeof child === "string") {
			if (child.length > 0) out.push(text({ text: child }));
			continue;
		}
		out.push(child);
	}
	return out;
}
