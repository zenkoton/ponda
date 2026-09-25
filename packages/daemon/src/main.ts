/** daemon 子进程入口：node main.ts --env <env> [--home <dir>] [--idle-ms <n>] */
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCodingTools } from "../../coding-agent/src/core/tools/index.ts";
import { paths } from "../../core/src/paths.ts";
import { DEFAULT_IMAGE, detectBackend } from "../../sandbox/src/container.ts";
import { EchoAgentLoop } from "./agent-loop.ts";
import { agentToolsSystemPrompt, createMemoryTool, createSwarmTools, createTodoTools } from "./agent-tools.ts";
import { DaemonCore } from "./core.ts";
import { resolveModelConfig } from "./model-config.ts";
import { PiAgentLoop } from "./pi-loop.ts";
import { createSandboxToolGuard, resolveSessionPolicy } from "./tool-guard.ts";

function arg(name: string): string | undefined {
	const argv = process.argv.slice(2);
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

const env = arg("env") ?? "default";
const home = arg("home") ?? process.env.PONDA_HOME;
const idleMs = arg("idle-ms") !== undefined ? Number.parseInt(arg("idle-ms") as string, 10) : undefined;

if (home === undefined) {
	console.error("需要 --home 或 PONDA_HOME");
	process.exit(1);
}
if (!/^[a-z][a-z0-9-]{0,63}$/.test(env)) {
	console.error(`非法环境名：${env}`);
	process.exit(1);
}

const logFile = arg("log");
if (logFile !== undefined) {
	const fd = openSync(logFile, "a");
	process.stdout.write = ((chunk: string | Uint8Array) => {
		appendFileSync(fd, chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		appendFileSync(fd, chunk);
		return true;
	}) as typeof process.stderr.write;
}

/** 环境目录的 SYSTEM.md（渲染产物，01 §2.2）作为会话 system prompt */
function readSystemPrompt(): string | undefined {
	const f = join(paths.env(home as string, env), "SYSTEM.md");
	if (!existsSync(f)) return undefined;
	try {
		const text = readFileSync(f, "utf8").trim();
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

const modelConfig = resolveModelConfig(home, env);
const defaultPolicy = resolveSessionPolicy(home, env, null);

const core = new DaemonCore({
	home,
	env,
	idleMs,
	defaultPermissionMode: defaultPolicy.permissionMode,
	loopFor:
		modelConfig !== null
			? (core, ctx) => {
					// 真实链路（P4）：每会话独立 Agent + coding 工具 + sandbox 守卫。
					// 工具集随会话工作区构造（read/bash/edit/write，03 §7.1 拦截面）
					const workspace = ctx.workspace ?? (home as string);
					const session = resolveSessionPolicy(home, env, ctx.workspace);
					const sessionId = ctx.sessionId;
					// 模型工具面（05 §2 todolist / §6 swarm / 02 §7 memory）：闭包直连
					// daemon 运行时；taskId 取该会话的 goal 任务（缺省 session 看板）
					const currentTaskId = () =>
						core.tasks.list().find((t) => t.sessionId === sessionId)?.taskId ?? "session";
					const loop = new PiAgentLoop({
						modelId: modelConfig.modelId,
						model: modelConfig.model,
						systemPrompt: `${readSystemPrompt() ?? ""}${agentToolsSystemPrompt()}`,
						getApiKey: modelConfig.getApiKey,
						sessionId,
						onStateEvent: (type, payload) => {
							core.telemetry.emit(type, payload, { sessionId });
						},
						onToolEvent: (e) => {
							core.appendToolEntry(sessionId, e);
							core.telemetry.emit(
								"tool.result",
								{ tool: e.name, ok: e.ok, durationMs: e.durationMs, argsDigest: e.argsDigest },
								{ sessionId },
							);
						},
						onTurnEnd: () => {
							// 03 §5.2 模式 A 快照链：每轮变更落 ponda/snapshots/<session>
							core.sandboxTracker.snapshotTurn(sessionId, workspace);
						},
						tools: [
							...createCodingTools(workspace),
							...core.mcpTools,
							...createTodoTools(core.todos, currentTaskId),
							...createSwarmTools(core.swarm, () => ctx.workspace ?? workspace),
							createMemoryTool(home as string, env),
						],
					});
					loop.bindToolGuard(
						createSandboxToolGuard({
							home: home as string,
							sessionId,
							workspace,
							policy: session.policy,
							getMode: () => core.sessionMode(sessionId),
							requestPermission: (req) => core.requestPermission(req),
							onEvent: (type, payload) => {
								core.telemetry.emit(type as never, payload, { sessionId });
							},
						}),
					);
					return loop;
				}
			: undefined,
	// 未解析到模型：演示回声循环，首条回复明示配置方法（PM 审查 P0-1）
	loop:
		modelConfig === null
			? new EchoAgentLoop(
					"（演示模式：未配置模型，当前回复为回声。运行 `ponda provider add` 配置 provider，或设置 PONDA_MODEL 后重启 daemon。）",
				)
			: undefined,
});
core.onExit = (code) => process.exit(code);
process.on("unhandledRejection", (r) => {
	// 07 §2 error 埋点：全局未处理异常
	core.telemetry.emit("error", {
		source: "daemon",
		class: r instanceof Error ? r.name : typeof r,
		messageDigest: (r instanceof Error ? r.message : String(r)).slice(0, 200),
	});
});

process.on("SIGTERM", () => {
	void core.shutdown(0);
});

await core.start();
// 07 §2 container.lifecycle：会话沙箱形态（容器 / audit-only 降级，03 §2.1）
{
	const backend = detectBackend();
	core.telemetry.emit(
		"container.lifecycle",
		backend !== null
			? { backend: backend.id, image: DEFAULT_IMAGE, confinement: "container" }
			: { backend: null, confinement: "audit-only", downgradeReason: "docker/podman 不可用" },
	);
}
if (modelConfig !== null) {
	console.log(
		`ponda-agent daemon up: env=${env} home=${home} pid=${process.pid} model=${modelConfig.modelId} (${modelConfig.source})`,
	);
} else {
	console.log(`ponda-agent daemon up: env=${env} home=${home} pid=${process.pid} model=(未配置，演示回声模式)`);
}
