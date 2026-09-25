/**
 * 键位层（opencode 范式的分层 keymap 子集）：按键解析 → 模式栈 → 绑定表 → 命令。
 * 键定义集中为数据，替代散落的硬编码按键判断。
 */

export interface ParsedKey {
	name: string;
	/** name 为 "char" 时的字符（多字符 = 粘贴） */
	char?: string;
}

export function parseKey(data: string): ParsedKey | null {
	switch (data) {
		case "\x1b[A":
			return { name: "up" };
		case "\x1b[B":
			return { name: "down" };
		case "\x1b[C":
			return { name: "right" };
		case "\x1b[D":
			return { name: "left" };
		case "\x1b[H":
			return { name: "home" };
		case "\x1b[F":
			return { name: "end" };
		case "\x1b[5~":
			return { name: "pageup" };
		case "\x1b[6~":
			return { name: "pagedown" };
		case "\r":
		case "\n":
			return { name: "enter" };
		case "\x1b\r":
		case "\x1b\n":
			return { name: "alt+enter" };
		case "\t":
			return { name: "tab" };
		case "\x1b[Z":
			return { name: "shift+tab" };
		case "\x7f":
		case "\b":
			return { name: "backspace" };
		case "\x1b":
			return { name: "esc" };
	}
	if (data.length === 1 && data >= " ") return { name: "char", char: data };
	// Ctrl+字母（\x01-\x1a）统一解析为 ctrl+x 形式（leader 键 ctrl+x = \x18）
	if (data.length === 1 && data.charCodeAt(0) >= 1 && data.charCodeAt(0) <= 26) {
		return { name: `ctrl+${String.fromCharCode(data.charCodeAt(0) + 96)}` };
	}
	if (data.length > 1 && !data.includes("\x1b")) return { name: "paste", char: data };
	return null;
}

/** 模式栈 keymap：顶层模式优先匹配；无绑定时向底层回退 */
export class Keymap<Command extends string> {
	private readonly bindings = new Map<string, Map<string, Command>>();
	private readonly modeStack: string[] = [];

	setBindings(mode: string, bindings: Record<string, Command>): void {
		this.bindings.set(mode, new Map(Object.entries(bindings)));
	}

	pushMode(mode: string): void {
		this.modeStack.push(mode);
	}

	popMode(): void {
		this.modeStack.pop();
	}

	/** 清空模式栈（互斥模式下每次重建单层） */
	clearModes(): void {
		this.modeStack.length = 0;
	}

	activeMode(): string {
		return this.modeStack[this.modeStack.length - 1] ?? "base";
	}

	/** 命中返回命令名；无命中返回 null（调用方决定字符回退行为）。可打印字符按字符本身查表 */
	dispatch(key: ParsedKey): Command | null {
		for (let i = this.modeStack.length - 1; i >= 0; i--) {
			const mode = this.modeStack[i];
			if (mode === undefined) continue;
			const bindings = this.bindings.get(mode);
			if (bindings === undefined) continue;
			const cmd = bindings.get(key.name) ?? bindings.get(key.char ?? "");
			if (cmd !== undefined) return cmd;
		}
		return null;
	}
}
