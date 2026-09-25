import type { Terminal } from "../src/terminal.ts";

/** 无头终端：记录写出字节，支持注入输入与 resize（不仿真 ANSI，断言走 onFrame） */
export class VirtualTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private cols: number;
	private rowsCount: number;
	readonly writes: string[] = [];

	constructor(cols = 80, rows = 24) {
		this.cols = cols;
		this.rowsCount = rows;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return this.cols;
	}

	get rows(): number {
		return this.rowsCount;
	}

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rowsCount = rows;
		this.resizeHandler?.();
	}

	writtenBytes(): number {
		return this.writes.reduce((a, w) => a + w.length, 0);
	}
}

/** 只统计字节数的包装终端（差分渲染证据用） */
export class CountingTerminal implements Terminal {
	private readonly inner: Terminal;
	bytes = 0;

	constructor(inner: Terminal) {
		this.inner = inner;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inner.start(onInput, onResize);
	}

	stop(): void {
		this.inner.stop();
	}

	write(data: string): void {
		this.bytes += data.length;
		this.inner.write(data);
	}

	get columns(): number {
		return this.inner.columns;
	}

	get rows(): number {
		return this.inner.rows;
	}
}
