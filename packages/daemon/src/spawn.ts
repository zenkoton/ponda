/**
 * ensureDaemon：懒启动助手（design: 05 §5.1）。
 * 先 ping 现有 daemon；不通则 detached 拉起子进程并等待就绪（M5 TUI / CLI 共用）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../../core/src/paths.ts";
import { Methods, RpcClient } from "../../rpc/src/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN = join(__dirname, "main.ts");

export interface DaemonHandle {
	client: RpcClient;
	pid: number;
}

export function daemonSocket(home: string, env: string): string {
	return join(paths.daemon(home), `${env}.sock`);
}

export async function pingDaemon(home: string, env: string): Promise<DaemonHandle | null> {
	const client = new RpcClient();
	try {
		await client.connect(daemonSocket(home, env), 800);
		const pong = await client.request<{ pid: number }>(Methods.daemonPing, undefined, 1500);
		return { client, pid: pong.pid };
	} catch {
		client.close();
		return null;
	}
}

export async function ensureDaemon(
	home: string,
	env: string,
	opts: { idleMs?: number; startupTimeoutMs?: number } = {},
): Promise<DaemonHandle> {
	const existing = await pingDaemon(home, env);
	if (existing !== null) return existing;

	const dir = paths.daemon(home);
	mkdirSync(dir, { recursive: true });
	const logFd = openSync(join(dir, `${env}.log`), "a");
	// node:sqlite（durable/metrics 存储）在 Node 24 仍是实验特性，抑制其启动警告
	// 双形态：源码 checkout 直跑 main.ts；打包形态（bundle 内无 main.ts）经 CLI 的
	// `_daemon` 子命令自派生（process.argv[1] = ponda 可执行入口）
	const bundled = !existsSync(MAIN);
	const self = process.argv[1];
	const child = spawn(
		process.execPath,
		[
			"--disable-warning=ExperimentalWarning",
			...(bundled ? [self ?? "ponda", "_daemon"] : [MAIN]),
			"--env",
			env,
			"--home",
			home,
			...(opts.idleMs !== undefined ? ["--idle-ms", String(opts.idleMs)] : []),
		],
		{
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: { ...process.env, PONDA_HOME: home },
		},
	);
	child.unref();

	const deadline = Date.now() + (opts.startupTimeoutMs ?? 5000);
	for (;;) {
		const h = await pingDaemon(home, env);
		if (h !== null) return h;
		if (Date.now() > deadline) throw new Error(`daemon 启动超时（env=${env}）`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
