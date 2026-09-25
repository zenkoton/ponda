/** `ponda tui`：三栏读视图（M5 第一批，design: 04-tui.md） */

import type { EnvStore } from "../../../core/src/store.ts";
import { ensureDaemon } from "../../../daemon/src/spawn.ts";
import type { Terminal } from "../../../tui/src/terminal.ts";
import { c } from "../ui.ts";
import { currentEnv } from "./env.ts";

/** 快照模式用的最小 Terminal（implements pi-tui Terminal，仅收集帧） */
class SnapshotTerminal implements Terminal {
	written: string[] = [];
	private readonly cols: number;
	private readonly rowsV: number;

	constructor(cols: number, rowsV: number) {
		this.cols = cols;
		this.rowsV = rowsV;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.written.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.rowsV;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

export async function runTui(store: EnvStore, args: string[], flags: Map<string, string | boolean>): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	if (!store.exists(env)) {
		console.error(`环境不存在：${env}`);
		return 2;
	}
	const snapshot = flags.get("snapshot") === true;
	const preferred = typeof args[0] === "string" ? args[0] : undefined;

	const handle = await ensureDaemon(store.home, env);
	const { PondaTui } = await import("../../../tui/src/ponda/app.ts");

	if (snapshot) {
		// 无头快照：渲染一帧到 stdout（CI/日志可演示）
		const term = new SnapshotTerminal(100, 30);
		const frames: string[][] = [];
		const app = new PondaTui({
			env,
			home: store.home,
			client: handle.client,
			terminal: term,
			onFrame: (lines) => frames.push(lines),
		});
		await app.start(preferred);
		for (let i = 0; i < 100 && frames.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		await app.stop();
		const frame = frames[frames.length - 1] ?? [];
		const { stripAnsi } = await import("../../../tui/src/ponda/view.ts");
		for (const line of frame) console.log(stripAnsi(line));
		handle.client.close();
		return 0;
	}

	// 交互模式：真终端
	if (process.stdout.isTTY !== true) {
		console.error("当前不是 TTY；使用 ponda tui --snapshot 输出一帧，或附加 --env 指定环境。");
		handle.client.close();
		return 1;
	}
	const { ProcessTerminal } = await import("../../../tui/src/terminal.ts");
	const term = new ProcessTerminal();
	const app = new PondaTui({ env, home: store.home, client: handle.client, terminal: term });
	await app.start(preferred);
	console.log(c.dim("（读视图：q 退出 · j/k 滚动 · Tab 切换会话；输入区 M5 第二批）"));
	await new Promise<void>((resolve) => {
		const t = setInterval(() => {
			if (!app.isRunning) {
				clearInterval(t);
				resolve();
			}
		}, 100);
	});
	handle.client.close();
	return 0;
}
