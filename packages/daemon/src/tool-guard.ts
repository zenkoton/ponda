/**
 * sandbox-guard 的 daemon 侧实现（design: 03 §7）：把三域路由、bash 高危分析、
 * 权限三档模式（03 §7.3）接进真实工具执行管线（PiAgentLoop.bindToolGuard）。
 * - write/edit：routeWrite 三域路由；工作区外按策略进临时工作区（改写入参）或拒绝
 * - bash：analyzeBash 高危名单 → 权限申请；plan 模式下一切执行均需确认
 * - read/grep/find/ls：读路径默认放行（03 §7.1）
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { paths } from "../../core/src/paths.ts";
import type { PermissionMode } from "../../core/src/types.ts";
import { analyzeBash, routeWrite, type SandboxPolicyLite } from "../../sandbox/src/domains.ts";
import { createSandbox, mapPath, type TempSandbox } from "../../sandbox/src/tempws.ts";
import type { ToolGuard, ToolGuardDecision } from "./pi-loop.ts";

/** 会话级沙箱策略与权限模式默认值（环境 manifest → 工作区 .ponda/ponda.json 覆盖，03 §3） */
export interface SessionPolicy {
	policy: SandboxPolicyLite;
	permissionMode: PermissionMode;
}

export function resolveSessionPolicy(home: string, env: string, workspace: string | null): SessionPolicy {
	const result: SessionPolicy = {
		policy: { mode: "inplace", autoGitInit: true, outsideWorkspace: "temp-workspace" },
		permissionMode: "approve",
	};
	try {
		const f = join(paths.env(home, env), "manifest.json");
		if (existsSync(f)) {
			const m = JSON.parse(readFileSync(f, "utf8")) as {
				privileges?: { sandbox?: Partial<SandboxPolicyLite> };
				runtime?: { permissionMode?: PermissionMode };
			};
			if (m.privileges?.sandbox !== undefined) {
				const s = m.privileges.sandbox;
				if (s.mode === "worktree" || s.mode === "inplace") result.policy.mode = s.mode;
				if (s.outsideWorkspace === "deny" || s.outsideWorkspace === "temp-workspace") {
					result.policy.outsideWorkspace = s.outsideWorkspace;
				}
				if (typeof s.autoGitInit === "boolean") result.policy.autoGitInit = s.autoGitInit;
			}
			if (m.runtime?.permissionMode !== undefined) result.permissionMode = m.runtime.permissionMode;
		}
	} catch {
		// 坏 manifest：走默认策略
	}
	if (workspace !== null) {
		try {
			const f = join(workspace, ".ponda", "ponda.json");
			if (existsSync(f)) {
				const w = JSON.parse(readFileSync(f, "utf8")) as { sandbox?: { mode?: "inplace" | "worktree" } };
				if (w.sandbox?.mode === "worktree" || w.sandbox?.mode === "inplace") {
					result.policy.mode = w.sandbox.mode;
				}
			}
		} catch {
			// 坏工作区配置：忽略
		}
	}
	return result;
}

export type GuardPermissionRequester = (req: {
	privilege: "read" | "write" | "execute";
	reason: string;
	detail: { tool: string; targetPath?: string; command?: string; mode: "C" | "B" | "danger" };
}) => Promise<{ approved: boolean; scope: "once" | "session" | "env-always" }>;

export interface SandboxToolGuardOptions {
	home: string;
	sessionId: string;
	/** 会话工作区（session.new 的 workspace；null 时以 home 兜底） */
	workspace: string;
	policy: SandboxPolicyLite;
	/** 会话级权限模式（TUI /mode 可切换，03 §7.3） */
	getMode: () => PermissionMode;
	requestPermission: GuardPermissionRequester;
	/** telemetry 埋点（07 §2 tool.call / permission.*） */
	onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

const WRITE_TOOLS = new Set(["write", "edit"]);
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function createSandboxToolGuard(opts: SandboxToolGuardOptions): ToolGuard {
	/** 会话级预授缓存（scope=session / env-always 的批准按 privilege 粒度记住） */
	const sessionGrants = new Set<string>();
	let sandboxSeq = 0;
	/** 本会话的临时工作区沙箱（03 §4：一次任务触碰多少区外文件就拷多少；这里按需累积） */
	let sandbox: TempSandbox | null = null;

	const allow = (route: string): ToolGuardDecision => {
		opts.onEvent?.("tool.call", { tool: "", route });
		return { allowed: true, reason: route };
	};

	async function ask(args: {
		privilege: "read" | "write" | "execute";
		reason: string;
		tool: string;
		targetPath?: string;
		command?: string;
		permMode: "C" | "B" | "danger";
	}): Promise<ToolGuardDecision> {
		const key = `${args.privilege}:${args.permMode}`;
		if (sessionGrants.has(key)) {
			opts.onEvent?.("permission.decision", { privilege: args.privilege, decision: "session-grant" });
			return { allowed: true, reason: "本会话已预授" };
		}
		opts.onEvent?.("permission.request", { privilege: args.privilege, tool: args.tool, reason: args.reason });
		const answer = await opts.requestPermission({
			privilege: args.privilege,
			reason: args.reason,
			detail: { tool: args.tool, targetPath: args.targetPath, command: args.command, mode: args.permMode },
		});
		opts.onEvent?.("permission.decision", {
			privilege: args.privilege,
			decision: answer.approved ? answer.scope : "deny",
		});
		if (!answer.approved) {
			return { allowed: false, reason: `用户拒绝了该操作：${args.reason}` };
		}
		if (answer.scope !== "once") sessionGrants.add(key);
		return { allowed: true, reason: `${args.reason}（已${answer.scope === "once" ? "单次" : "会话"}批准）` };
	}

	return {
		beforeToolCall: async (call): Promise<ToolGuardDecision> => {
			const mode = opts.getMode();
			const args = call.arguments;
			if (WRITE_TOOLS.has(call.name)) {
				// 相对路径按会话工作区解析（write/edit 工具自身也以工作区为 cwd，03 §3 口径一致）
				const rawTarget = typeof args.path === "string" ? args.path : "";
				if (rawTarget === "") return { allowed: false, reason: "write/edit 缺少 path 参数" };
				const target = isAbsolute(rawTarget) ? rawTarget : join(opts.workspace, rawTarget);
				const decision = routeWrite(target, { workspaceRoot: opts.workspace, policy: opts.policy });
				opts.onEvent?.("tool.call", { tool: call.name, route: decision.mode, path: target });
				if (decision.mode === "deny") {
					return { allowed: false, reason: decision.reason };
				}
				if (decision.mode === "temp-workspace") {
					// 工作区外写 → 临时工作区副本（03 §4）；写回需用户经 sandbox settle 确认
					if (sandbox === null) {
						sandboxSeq++;
						sandbox = createSandbox(opts.sessionId, sandboxSeq, [decision.rewrittenPath], opts.home);
					} else if (mapPath(sandbox, decision.rewrittenPath) === null) {
						// 后续新触碰的区外文件补拷进同一沙箱（settle 时一起结算）
						sandboxSeq++;
						const next = createSandbox(
							`${opts.sessionId}-x${sandboxSeq}`,
							1,
							[decision.rewrittenPath],
							opts.home,
						);
						sandbox = mergeSandboxes(sandbox, next);
					}
					const mapped = sandbox !== null ? mapPath(sandbox, decision.rewrittenPath) : null;
					if (mapped === null) {
						return { allowed: false, reason: "临时工作区映射失败（内部错误）" };
					}
					if (mode === "plan") {
						const r = await ask({
							privilege: "write",
							reason: `plan 模式：写入工作区外文件 ${target}（临时工作区副本）`,
							tool: call.name,
							targetPath: target,
							permMode: "C",
						});
						if (!r.allowed) return r;
					}
					return {
						allowed: true,
						reason: "工作区外文件已重定向到临时工作区副本（写回需确认）",
						rewritten: { ...args, path: mapped },
					};
				}
				// 工作区内（inplace / worktree）：plan 一律确认，approve/full-auto 预授（03 §7.3）
				if (mode === "plan") {
					return await ask({
						privilege: "write",
						reason: `plan 模式：写入 ${target}`,
						tool: call.name,
						targetPath: target,
						permMode: "B",
					});
				}
				return { allowed: true, reason: decision.reason };
			}
			if (call.name.startsWith("skill:")) {
				// pi 的技能命令工具形态 /skill:* → 07 §2 skill.invoke 埋点
				opts.onEvent?.("skill.invoke", { skillName: call.name.slice("skill:".length), success: true });
				return allow("skill");
			}
			if (call.name === "bash") {
				const command = typeof args.command === "string" ? args.command : "";
				const analysis = analyzeBash(command);
				opts.onEvent?.("tool.call", { tool: "bash", route: "bash", danger: analysis.dangerous.length });
				if (mode === "plan") {
					return await ask({
						privilege: "execute",
						reason: "plan 模式：执行命令需确认",
						tool: "bash",
						command,
						permMode: "B",
					});
				}
				if (analysis.dangerous.length > 0) {
					return await ask({
						privilege: "execute",
						reason: `高危命令（${analysis.dangerous.map((d) => d.label).join("、")}）：${command}`,
						tool: "bash",
						command,
						permMode: "danger",
					});
				}
				return { allowed: true, reason: "bash 预授（approve/full-auto）" };
			}
			if (READ_TOOLS.has(call.name)) {
				return allow("read");
			}
			return allow("unknown");
		},
		afterToolCall: (call, result) => {
			opts.onEvent?.("tool.result", { tool: call.name, ok: result.ok, durationMs: result.durationMs });
		},
	};
}

/** 多个按需沙箱合并视图（映射查两级；结算仍按各自 sandbox 进行） */
function mergeSandboxes(a: TempSandbox, b: TempSandbox): TempSandbox {
	return {
		id: a.id,
		dir: a.dir,
		createdAt: a.createdAt,
		mappings: { ...a.mappings, ...b.mappings },
	};
}
