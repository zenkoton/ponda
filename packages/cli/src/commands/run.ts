/**
 * `ponda run -p "<prompt>"`：headless 非交互模式（对标 claude -p，PM P1）。
 * 经 ensureDaemon 驱动环境会话：session.new（或续用最近 live 会话）→ session.send
 * → 轮询 session.list 至 processing=false → 读会话 JSONL 尾部 assistant 文本输出。
 * 复用 daemon 真实链路（PiAgentLoop 工具链 + sandbox 守卫 + 快照链）。
 * 退出码：0 成功 / 1 错误 / 2 环境不存在 / 4 超时。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../../core/src/paths.ts";
import type { EnvStore } from "../../../core/src/store.ts";
import { ensureDaemon } from "../../../daemon/src/spawn.ts";
import { Methods } from "../../../rpc/src/index.ts";
import { c } from "../ui.ts";
import { currentEnv } from "./env.ts";

export async function runRun(
	store: EnvStore,
	args: string[],
	flags: Map<string, string | boolean>,
	json: boolean,
): Promise<number> {
	const prompt = typeof flags.get("prompt") === "string" ? (flags.get("prompt") as string) : args[0];
	if (prompt === undefined || prompt.length === 0) {
		console.error(
			'用法：ponda run -p "<prompt>" [--env E] [--json] [--new-session] [--mode plan|approve|full-auto] [--timeout 秒]',
		);
		return 1;
	}
	const env = typeof flags.get("env") === "string" ? (flags.get("env") as string) : currentEnv(store).env;
	if (!store.exists(env)) {
		console.error(`环境不存在：${env}（先运行 ponda init）`);
		return 2;
	}
	const workspace = typeof flags.get("workspace") === "string" ? (flags.get("workspace") as string) : process.cwd();
	const timeoutMs =
		typeof flags.get("timeout") === "number" || typeof flags.get("timeout") === "string"
			? Number(flags.get("timeout")) * 1000
			: 300 * 1000;
	const mode = typeof flags.get("mode") === "string" ? (flags.get("mode") as string) : undefined;

	const handle = await ensureDaemon(store.home, env);
	try {
		// 会话选择：默认续用最近 live 会话（opencode 式续聊）；--new-session 强制新建
		let sessionId: string | null = null;
		if (flags.get("new-session") !== true) {
			const list = await handle.client.request<
				{ sessionId: string; status: string; processing: boolean; entryCount: number }[]
			>(Methods.sessionList);
			// 续用最近活跃的 live 会话（entryCount 最大者；多 live 时行为确定）
			const live = list
				.filter((s) => s.status === "running" || s.status === "detached")
				.sort((a, b) => b.entryCount - a.entryCount)[0];
			if (live !== undefined) sessionId = live.sessionId;
		}
		if (sessionId === null) {
			const created = await handle.client.request<{ sessionId: string }>(Methods.sessionNew, { workspace });
			sessionId = created.sessionId;
		}
		if (mode !== undefined) {
			if (!["plan", "approve", "full-auto"].includes(mode)) {
				console.error(`--mode 非法：${mode}（plan | approve | full-auto）`);
				return 1;
			}
			await handle.client.request(Methods.sessionSetMode, { sessionId, mode });
		}

		await handle.client.request(Methods.sessionSend, { sessionId, text: prompt });

		// 轮询至处理完成（headless 无事件流；权限弹窗若触发将按超时拒绝并继续）
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const list = await handle.client.request<{ sessionId: string; processing: boolean }[]>(Methods.sessionList);
			const row = list.find((s) => s.sessionId === sessionId);
			if (row === undefined) {
				console.error("会话消失（daemon 异常）");
				return 1;
			}
			if (!row.processing) break;
			if (Date.now() > deadline) {
				console.error(`超时（${timeoutMs / 1000}s）：会话仍在处理；可 --timeout 加大或 ponda tui attach 查看`);
				return 4;
			}
			await new Promise((r) => setTimeout(r, 100));
		}

		const result = readLastAssistant(store.home, env, sessionId);
		if (json) {
			console.log(
				JSON.stringify({ sessionId, env, text: result.text, usage: result.usage, mode: mode ?? null }, null, 2),
			);
			return 0;
		}
		if (result.text.length === 0) {
			console.error(
				c.yellow("（无 assistant 输出——检查模型配置（PONDA_MODEL / ponda provider add）或 ponda doctor）"),
			);
			return 1;
		}
		console.log(result.text);
		return 0;
	} finally {
		handle.client.close();
	}
}

/** 读会话 JSONL 尾部最后一条 assistant 文本与累计 usage（headless 输出；daemon 会话文件是事实源） */
function readLastAssistant(
	home: string,
	env: string,
	sessionId: string,
): { text: string; usage: { input: number; output: number; costUsd: number } } {
	const file = join(paths.env(home, env), "sessions", `${sessionId}.jsonl`);
	if (!existsSync(file)) return { text: "", usage: { input: 0, output: 0, costUsd: 0 } };
	let text = "";
	let usage = { input: 0, output: 0, costUsd: 0 };
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		try {
			const e = JSON.parse(line) as {
				type?: string;
				message?: {
					role?: string;
					content?: { type: string; text?: string }[];
					usage?: { input?: number; output?: number; cost?: { total?: number } };
				};
			};
			if (e.type !== "message" || e.message?.role !== "assistant") continue;
			const t = (e.message.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("\n");
			if (t.length > 0) text = t;
			if (e.message.usage) {
				usage = {
					input: usage.input + (e.message.usage.input ?? 0),
					output: usage.output + (e.message.usage.output ?? 0),
					costUsd: Math.round((usage.costUsd + (e.message.usage.cost?.total ?? 0)) * 1e6) / 1e6,
				};
			}
		} catch {
			// 坏行跳过
		}
	}
	return { text, usage };
}
