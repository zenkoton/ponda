/**
 * Screen：opencode 范式的帧循环在 TS 侧的对应物。
 * 根 effect 求值组件树并渲染整帧，依赖的任一信号变化即重渲染；
 * 写出层做行级差分（首帧/resize 全量，其后只重写变更行，同步输出包裹）。
 * 终端采用备用屏（alt screen），退出时恢复原始终端内容。
 */

import type { Element } from "./element.ts";
import { renderTree } from "./paint.ts";
import { batch, createEffect, createRoot, createSignal, untrack } from "./signal.ts";
import type { Terminal } from "./terminal.ts";

export interface ScreenOptions {
	terminal: Terminal;
	/** 每帧求值：返回当前元素树（内部读取的信号自动成为帧依赖） */
	root: () => Element;
	onFrame?: (lines: string[]) => void;
	onInput?: (data: string) => void;
}

const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export class Screen {
	private readonly opts: ScreenOptions;
	private readonly width: () => number;
	private readonly setWidth: (v: number) => void;
	private readonly height: () => number;
	private readonly setHeight: (v: number) => void;
	private dispose: (() => void) | null = null;
	private previous: string[] | null = null;
	private started = false;

	constructor(opts: ScreenOptions) {
		this.opts = opts;
		[this.width, this.setWidth] = createSignal(80);
		[this.height, this.setHeight] = createSignal(24);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.opts.terminal.start(
			(data: string) => this.opts.onInput?.(data),
			() => {
				batch(() => {
					this.setWidth(this.opts.terminal.columns);
					this.setHeight(this.opts.terminal.rows);
				});
				this.previous = null; // resize 后全量重绘
			},
		);
		this.setWidth(this.opts.terminal.columns);
		this.setHeight(this.opts.terminal.rows);
		this.opts.terminal.write(`${ALT_ENTER}${HIDE_CURSOR}`);
		this.dispose = createRoot((dispose) => {
			createEffect(() => {
				const lines = renderTree(this.opts.root(), this.width(), this.height());
				untrack(() => {
					this.opts.onFrame?.(lines);
					this.writeFrame(lines);
				});
			});
			return dispose;
		});
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.dispose?.();
		this.dispose = null;
		this.previous = null;
		this.opts.terminal.write(`${ALT_EXIT}${SHOW_CURSOR}`);
		this.opts.terminal.stop();
	}

	private writeFrame(lines: string[]): void {
		const previous = this.previous;
		if (previous === null || previous.length !== lines.length) {
			const out: string[] = [SYNC_BEGIN, "\x1b[2J"];
			for (let i = 0; i < lines.length; i++) {
				out.push(`\x1b[${i + 1};1H\x1b[2K${lines[i] ?? ""}`);
			}
			out.push(SYNC_END);
			this.opts.terminal.write(out.join(""));
			this.previous = lines;
			return;
		}
		const out: string[] = [SYNC_BEGIN];
		let wrote = false;
		for (let i = 0; i < lines.length; i++) {
			if (previous[i] === lines[i]) continue;
			out.push(`\x1b[${i + 1};1H\x1b[2K${lines[i] ?? ""}`);
			wrote = true;
		}
		if (wrote) {
			out.push(SYNC_END);
			this.opts.terminal.write(out.join(""));
		}
		this.previous = lines;
	}
}
