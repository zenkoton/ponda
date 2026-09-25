/**
 * @ponda/tui：ponda 的 TUI 运行时（opencode 范式移植）。
 *
 * 分层：
 * - signal.ts   solid 风格细粒度响应式（createSignal/createMemo/createEffect/batch）
 * - element.ts  声明式元素模型（box/text/rich/modal 工厂 + 函数组件）
 * - layout.ts   flexbox 布局（row/column、grow/shrink/basis、百分比、min/max）
 * - paint.ts    cell buffer 绘制 → ANSI 行
 * - screen.ts   帧循环（根 effect + 行差分写出 + alt screen）
 * - terminal.ts 终端驱动（raw mode + 转义序列拆分）
 * - keys.ts     分层 keymap（模式 → 绑定 → 命令）
 * - markdown.ts 迷你 Markdown → 元素
 *
 * 应用侧（三栏界面）在 ./app/ 下。
 */

export {
	type BorderOptions,
	type BoxElement,
	type BoxProps,
	box,
	type Color,
	type Element,
	type ElementChild,
	type ModalElement,
	modal,
	normalizeChildren,
	type Percent,
	type RichTextElement,
	rich,
	type ScrollElement,
	type Size,
	type Span,
	scroll,
	type TextElement,
	type TextProps,
	type TextStyle,
	text,
} from "./element.ts";
export { Keymap, type ParsedKey, parseKey } from "./keys.ts";
export { type LaidNode, layout, resolveSize } from "./layout.ts";
export {
	DEFAULT_MD_THEME,
	type MdBlock,
	type MdTheme,
	markdownElements,
	parseInline,
	parseMarkdown,
} from "./markdown.ts";
export { renderTree } from "./paint.ts";
export { Screen, type ScreenOptions } from "./screen.ts";
export {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	onCleanup,
	type ReactiveRoot,
	untrack,
} from "./signal.ts";
export {
	ProcessTerminal,
	resolveEscapeTimeoutMs,
	SequenceSplitter,
	type Terminal,
} from "./terminal.ts";
export { charWidth, graphemes, visibleWidth, wrapText } from "./text-util.ts";
