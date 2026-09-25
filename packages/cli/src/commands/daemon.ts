/** `ponda daemon start|stop|status [--env]`（design: 05-runtime.md §5.1） */

import type { EnvStore } from "../../../core/src/store.ts";
import { DaemonCore } from "../../../daemon/src/core.ts";
import { ensureDaemon, pingDaemon } from "../../../daemon/src/spawn.ts";
import { Methods } from "../../../rpc/src/index.ts";
import { c } from "../ui.ts";
import { currentEnv } from "./env.ts";

export async function runDaemon(
	store: EnvStore,
	action: string,
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	if (!store.exists(env)) {
		console.error(`环境不存在：${env}`);
		return 2;
	}

	switch (action) {
		case "status": {
			const h = await pingDaemon(store.home, env);
			if (h === null) {
				if (json) {
					console.log(JSON.stringify({ env, up: false }));
					return 0;
				}
				console.log(c.dim(`daemon(${env}) 未运行`));
				return 0;
			}
			const sessions = await h.client.request<{ sessionId: string; status: string }[]>(Methods.sessionList);
			h.client.close();
			if (json) {
				console.log(JSON.stringify({ env, up: true, pid: h.pid, sessions }, null, 2));
				return 0;
			}
			console.log(c.green("✓"), `daemon(${env}) 运行中 pid=${h.pid}，会话 ${sessions.length} 个：`);
			for (const s of sessions) {
				console.log(`  ${s.sessionId.slice(0, 8)}  ${s.status}`);
			}
			return 0;
		}

		case "start": {
			const h = await ensureDaemon(store.home, env);
			h.client.close();
			console.log(c.green("✓"), `daemon(${env}) 已就绪 pid=${h.pid}`);
			return 0;
		}

		case "stop": {
			const h = await pingDaemon(store.home, env);
			if (h === null) {
				console.log(c.dim(`daemon(${env}) 未运行`));
				return 0;
			}
			await h.client.request(Methods.daemonShutdown);
			h.client.close();
			console.log(c.green("✓"), `daemon(${env}) 已停止`);
			return 0;
		}

		default:
			console.error(
				`可用动作：status | start | stop [--env <env>]（核心类导出：DaemonCore/${ensureDaemon.name}/${DaemonCore.name}）`,
			);
			return 1;
	}
}
