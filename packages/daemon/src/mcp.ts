/**
 * MCP 客户端（design: 02 §4 mcp-server / 00 §1.1 mcp.json 消费）：
 * daemon 加载 envs/<env>/mcp.json 声明的 stdio servers（spawn 子进程 + ndjson
 * JSON-RPC），把其工具包装为 AgentTool（命名 mcp__<server>__<tool>）注入
 * PiAgentLoop 工具面——"per-env MCP 隔离"落到运行时。
 * 单个 server 启动/调用失败只降级该 server（记 warning），不阻塞 daemon。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "../../agent/src/index.ts";
import { paths } from "../../core/src/paths.ts";
import type { McpServerConfig } from "../../core/src/types.ts";

interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: number | string;
	result?: unknown;
	error?: { message: string };
}

const STARTUP_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 60000;

export class McpClient {
	readonly serverName: string;
	private readonly def: McpServerConfig;
	private proc: ChildProcessWithoutNullStreams | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private buffer: string[] = [];
	private toolsCache: McpToolDef[] | null = null;

	constructor(serverName: string, def: McpServerConfig) {
		this.serverName = serverName;
		this.def = def;
	}

	/** spawn + initialize 握手 + notifications/initialized */
	async start(): Promise<void> {
		if (this.def.command === undefined)
			throw new Error(`mcp server "${this.serverName}" 缺少 command（url/socket 传输暂不支持）`);
		const proc = spawn(this.def.command, this.def.args ?? [], {
			env: { ...process.env, ...this.def.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc = proc as ChildProcessWithoutNullStreams;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
		const failAll = (reason: string): void => {
			for (const [, p] of this.pending) p.reject(new Error(`mcp server "${this.serverName}" ${reason}`));
			this.pending.clear();
		};
		proc.on("exit", () => failAll("exited"));
		proc.on("error", (err) => failAll(`启动失败：${err.message}`));
		await this.request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "ponda", version: "0.1.0" },
			},
			STARTUP_TIMEOUT_MS,
		);
		// initialized 通知（无 id，无需等待响应）
		this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	}

	private onStdout(chunk: string): void {
		// ndjson：按行拆分，保留最后不完整行继续缓冲
		this.buffer.push(chunk);
		const complete = this.buffer.join("").split("\n");
		this.buffer = [complete.pop() ?? ""];
		for (const line of complete) {
			if (line.trim().length === 0) continue;
			try {
				const msg = JSON.parse(line) as JsonRpcResponse;
				if (msg.id !== undefined) {
					const p = this.pending.get(Number(msg.id));
					if (p !== undefined) {
						this.pending.delete(Number(msg.id));
						if (msg.error !== undefined) p.reject(new Error(msg.error.message));
						else p.resolve(msg.result);
					}
				}
			} catch {
				// 非 JSON 行忽略（server 日志等）
			}
		}
	}

	private request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		const proc = this.proc;
		if (proc === null) return Promise.reject(new Error("mcp client not started"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`mcp ${method} 超时（${timeoutMs}ms）`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	async listTools(): Promise<McpToolDef[]> {
		if (this.toolsCache !== null) return this.toolsCache;
		const result = (await this.request("tools/list", {})) as { tools?: McpToolDef[] };
		this.toolsCache = result?.tools ?? [];
		return this.toolsCache;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		const result = (await this.request("tools/call", { name, arguments: args })) as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
		};
		const text = (result?.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
		if (result?.isError === true) throw new Error(text || `mcp tool ${name} error`);
		return text;
	}

	/** 包装为 AgentTool（注入 PiAgentLoop 工具面；schema 直接采用 server 的 inputSchema） */
	async agentTools(): Promise<AgentTool<any>[]> {
		const defs = await this.listTools();
		return defs.map((t) => {
			const tool: AgentTool<any> = {
				name: `mcp__${this.serverName}__${t.name}`,
				label: t.name,
				description: t.description ?? `MCP tool ${t.name} (server: ${this.serverName})`,
				parameters: (t.inputSchema ?? { type: "object", properties: {} }) as never,
				execute: async (_id, params) => {
					const text = await this.callTool(t.name, (params ?? {}) as Record<string, unknown>);
					return { content: [{ type: "text", text }], details: undefined };
				},
			};
			return tool;
		});
	}

	stop(): void {
		try {
			this.proc?.stdin.end();
		} catch {}
		this.proc?.kill("SIGTERM");
		this.proc = null;
	}
}

export function loadMcpConfig(home: string, env: string): Record<string, McpServerConfig> {
	const file = join(paths.env(home, env), "mcp.json");
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, McpServerConfig> };
		return parsed?.mcpServers ?? {};
	} catch {
		return {};
	}
}

export interface McpLoadResult {
	tools: AgentTool<any>[];
	clients: McpClient[];
	warnings: string[];
}

/** 启动 mcp.json 声明的全部 server 并收集工具（失败 server 降级记录，不阻塞） */
export async function loadMcpTools(home: string, env: string): Promise<McpLoadResult> {
	const config = loadMcpConfig(home, env);
	const tools: AgentTool<any>[] = [];
	const clients: McpClient[] = [];
	const warnings: string[] = [];
	for (const [name, def] of Object.entries(config)) {
		if (def === null || def === undefined) continue;
		const client = new McpClient(name, def);
		try {
			await client.start();
			tools.push(...(await client.agentTools()));
			clients.push(client);
		} catch (e) {
			warnings.push(`mcp server "${name}" 启动失败：${e instanceof Error ? e.message : String(e)}`);
			client.stop();
		}
	}
	return { tools, clients, warnings };
}
