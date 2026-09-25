/** 终端输出小工具：ANSI 颜色（NO_COLOR/非 tty 自动关闭）、简易表格 */

const enabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;

export const c = {
	green: (s: string) => (enabled ? `\x1b[32m${s}\x1b[0m` : s),
	yellow: (s: string) => (enabled ? `\x1b[33m${s}\x1b[0m` : s),
	red: (s: string) => (enabled ? `\x1b[31m${s}\x1b[0m` : s),
	dim: (s: string) => (enabled ? `\x1b[2m${s}\x1b[0m` : s),
	bold: (s: string) => (enabled ? `\x1b[1m${s}\x1b[0m` : s),
	cyan: (s: string) => (enabled ? `\x1b[36m${s}\x1b[0m` : s),
};

/** 极简表格：首列为左对齐，其余右对齐可选 */
export function table(headers: string[], rows: (string | number)[][], leftAlign: number[] = [0]): string {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
	const line = (cells: (string | number)[]) =>
		cells
			.map((cell, i) => (leftAlign.includes(i) ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i])))
			.join("  ");
	return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

export function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
