/**
 * 多行输入编辑器（design: 04-tui.md §5.4；M5 第二批）。
 * 轻量缓冲 + 光标移动； '\\' 行尾接 Enter 或 Alt+Enter 换行，Enter 发送。
 */
export class PondaEditor {
	lines: string[] = [""];
	row = 0;
	col = 0;

	clear(): void {
		this.lines = [""];
		this.row = 0;
		this.col = 0;
	}

	get text(): string {
		return this.lines.join("\n");
	}

	get isEmpty(): boolean {
		return this.lines.length === 1 && this.lines[0] === "";
	}

	insertText(s: string): void {
		const line = this.lines[this.row] ?? "";
		this.lines[this.row] = line.slice(0, this.col) + s + line.slice(this.col);
		this.col += s.length;
	}

	newline(): void {
		const line = this.lines[this.row] ?? "";
		const before = line.slice(0, this.col);
		const after = line.slice(this.col);
		this.lines[this.row] = before;
		this.lines.splice(this.row + 1, 0, after);
		this.row++;
		this.col = 0;
	}

	backspace(): void {
		const line = this.lines[this.row] ?? "";
		if (this.col > 0) {
			this.lines[this.row] = line.slice(0, this.col - 1) + line.slice(this.col);
			this.col--;
			return;
		}
		if (this.row > 0) {
			const prev = this.lines[this.row - 1] as string;
			this.lines.splice(this.row, 1);
			this.row--;
			this.col = prev.length;
			this.lines[this.row] = prev + line;
		}
	}

	left(): void {
		if (this.col > 0) this.col--;
		else if (this.row > 0) {
			this.row--;
			this.col = (this.lines[this.row] ?? "").length;
		}
	}

	right(): void {
		const line = this.lines[this.row] ?? "";
		if (this.col < line.length) this.col++;
		else if (this.row < this.lines.length - 1) {
			this.row++;
			this.col = 0;
		}
	}

	up(): void {
		if (this.row > 0) {
			this.row--;
			this.clampCol();
		}
	}

	down(): void {
		if (this.row < this.lines.length - 1) {
			this.row++;
			this.clampCol();
		}
	}

	home(): void {
		this.col = 0;
	}

	end(): void {
		this.col = (this.lines[this.row] ?? "").length;
	}

	private clampCol(): void {
		this.col = Math.min(this.col, (this.lines[this.row] ?? "").length);
	}

	/** 光标所在行、从最近的 @ 或 / 起到光标的 token（含前缀符）；无则 null */
	currentToken(): { token: string; start: number } | null {
		const line = this.lines[this.row] ?? "";
		const before = line.slice(0, this.col);
		const m = before.match(/(?:^|\s)([@/][^\s]*)$/);
		if (m === null) return null;
		const token = m[1] as string;
		const start = this.col - token.length;
		return { token, start };
	}

	/** 用补全结果替换当前 token（保留前缀符后的匹配部分替换整段） */
	replaceCurrentToken(replacement: string): void {
		const t = this.currentToken();
		if (t === null) return;
		const line = this.lines[this.row] ?? "";
		const prefixChar = t.token[0] as string;
		const value = replacement.startsWith(prefixChar) ? replacement : `${prefixChar}${replacement}`;
		this.lines[this.row] = `${line.slice(0, t.start)}${value} ${line.slice(this.col)}`;
		this.col = t.start + value.length + 1;
	}

	/** 渲染：光标行以 ▮ 提示（真光标定位由渲染循环处理；无头/快照用标记代替） */
	renderLines(width: number): string[] {
		const inner = Math.max(8, width - 3);
		return this.lines.map((line, i) => {
			const cursor = i === this.row ? `${this.col >= line.length ? " " : ""}` : "";
			const text = line.length > inner ? `…${line.slice(line.length - inner + 1)}` : line;
			void cursor;
			return `${i === this.row ? "▏" : " "}${text}`;
		});
	}
}
