/**
 * 终端驱动（opencode 范式的 in-process 终端 I/O 环）。
 * ProcessTerminal：raw mode stdin + 转义序列拆分（CSI/SS3/OSC/Alt 组合，
 * 孤立 ESC 按超时判定）+ resize 回调；写输出直接进 stdout。
 */

export interface Terminal {
	start(onInput: (data: string) => void, onResize: () => void): void;
	stop(): void;
	write(data: string): void;
	readonly columns: number;
	readonly rows: number;
}

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const configured = Number(env.PONDA_TUI_ESC_TIMEOUT);
	if (Number.isFinite(configured) && configured > 0) return configured;
	if (env.SSH_CONNECTION || env.SSH_TTY) return DEFAULT_SSH_ESCAPE_TIMEOUT_MS;
	return DEFAULT_ESCAPE_TIMEOUT_MS;
}

/** 把连续字节流拆成单个按键序列：完整 CSI/SS3/OSC 一次性转发，孤立 ESC 超时转发 */
export class SequenceSplitter {
	private buffer = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly onSequence: (seq: string) => void;
	private readonly escapeTimeoutMs: number;

	constructor(onSequence: (seq: string) => void, escapeTimeoutMs: number = resolveEscapeTimeoutMs()) {
		this.onSequence = onSequence;
		this.escapeTimeoutMs = escapeTimeoutMs;
	}

	process(data: string): void {
		this.buffer += data;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.drain();
	}

	destroy(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		this.buffer = "";
	}

	private drain(): void {
		while (this.buffer.length > 0) {
			const esc = this.buffer.indexOf("\x1b");
			if (esc < 0) {
				this.emit(this.buffer);
				this.buffer = "";
				return;
			}
			if (esc > 0) {
				this.emit(this.buffer.slice(0, esc));
				this.buffer = this.buffer.slice(esc);
				continue;
			}
			const length = completeEscapeLength(this.buffer);
			if (length < 0) {
				this.scheduleEscapeTimeout();
				return;
			}
			this.emit(this.buffer.slice(0, length));
			this.buffer = this.buffer.slice(length);
		}
	}

	private emit(seq: string): void {
		if (seq.length > 0) this.onSequence(seq);
	}

	private scheduleEscapeTimeout(): void {
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.emit("\x1b");
			this.buffer = this.buffer.slice(1);
			this.drain();
		}, this.escapeTimeoutMs);
	}
}

/** 返回以 ESC 开头的完整序列长度；不完整返回 -1 */
function completeEscapeLength(s: string): number {
	if (s.length < 2) return -1;
	const second = s[1];
	if (second === "[") {
		for (let i = 2; i < s.length; i++) {
			const c = s.charCodeAt(i);
			if (c >= 0x40 && c <= 0x7e) return i + 1;
		}
		return -1;
	}
	if (second === "O") return s.length >= 3 ? 3 : -1;
	if (second === "]" || second === "P" || second === "X" || second === "^" || second === "_") {
		const bel = s.indexOf("\x07", 2);
		const st = s.indexOf("\x1b\\", 2);
		if (bel >= 0 && (st < 0 || bel < st)) return bel + 1;
		if (st >= 0) return st + 2;
		return -1;
	}
	return 2; // ESC + 字符 = Alt 组合键
}

export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private splitter: SequenceSplitter | null = null;
	private dataHandler: ((data: string) => void) | null = null;
	private resizeHandler: (() => void) | null = null;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) process.stdin.setRawMode(true);
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		this.splitter = new SequenceSplitter(onInput);
		this.dataHandler = (data: string) => {
			this.splitter?.process(data);
		};
		process.stdin.on("data", this.dataHandler);
		this.resizeHandler = onResize;
		process.stdout.on("resize", onResize);
	}

	stop(): void {
		if (this.dataHandler !== null) {
			process.stdin.removeListener("data", this.dataHandler);
			this.dataHandler = null;
		}
		this.splitter?.destroy();
		this.splitter = null;
		if (this.resizeHandler !== null) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = null;
		}
		process.stdin.pause();
		if (process.stdin.setRawMode) process.stdin.setRawMode(this.wasRaw);
	}

	write(data: string): void {
		process.stdout.write(data);
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	setTitle(title: string): void {
		process.stdout.write(`\x1b]0;${title}\x07`);
	}
}
