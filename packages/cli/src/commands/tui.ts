/** `ponda tui`：三栏界面（design: 04-tui.md；opencode 范式 TUI 运行时 @ponda/tui） */

import type { EnvStore } from "../../../core/src/store.ts";
import { ensureDaemon } from "../../../daemon/src/spawn.ts";
import type { Terminal } from "../../../tui-next/src/terminal.ts";
import { c } from "../ui.ts";
import { currentEnv } from "./env.ts";

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "");
}

/** 快照模式用的最小 Terminal（仅收集写出） */
class SnapshotTerminal implements Terminal {
	readonly written: string[] = [];
	private readonly cols: number;
	private readonly rowsV: number;

	constructor(cols: number, rowsV: number) {
		this.cols = cols;
		this.rowsV = rowsV;
	}

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	write(data: string): void {
		this.written.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.rowsV;
	}
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
	const { PondaTui } = await import("../../../tui-next/src/app/app.ts");

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
		for (const line of frame) console.log(stripAnsi(line));
		handle.client.close();
		return 0;
	}

	// 交互模式：真终端（备用屏 + 差分渲染）
	if (process.stdout.isTTY !== true) {
		console.error("当前不是 TTY；使用 ponda tui --snapshot 输出一帧，或附加 --env 指定环境。");
		handle.client.close();
		return 1;
	}
	const { ProcessTerminal } = await import("../../../tui-next/src/terminal.ts");
	const term = new ProcessTerminal();
	term.setTitle(`ponda tui · ${env}`);
	const app = new PondaTui({ env, home: store.home, client: handle.client, terminal: term });
	await app.start(preferred);
	await new Promise<void>((resolve) => {
		const t = setInterval(() => {
			if (!app.isRunning) {
				clearInterval(t);
				resolve();
			}
		}, 100);
	});
	console.log(c.dim("（ponda tui 已退出；后台会话由 daemon 托管）"));
	handle.client.close();
	return 0;
}
