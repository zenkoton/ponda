/**
 * 三域路由：写入/命令操作按目标路径路由到 inplace / worktree / temp-workspace（design: 03 §3）。
 * 纯逻辑模块（fs 探测经注入），便于无头测试。
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface SandboxPolicyLite {
	mode: "inplace" | "worktree";
	autoGitInit: boolean;
	outsideWorkspace: "deny" | "temp-workspace";
}

export type SandboxRouteMode = "inplace" | "worktree" | "temp-workspace" | "deny";

export interface RouteContext {
	workspaceRoot: string;
	policy: SandboxPolicyLite;
	/** worktree 模式下 agent 的实际根（workspaceRoot/.ponda/worktrees/<id>） */
	worktreeRoot?: string;
}

export interface RouteDecision {
	mode: SandboxRouteMode;
	/** 重写后的目标路径（temp 模式指向沙箱副本；其余原样） */
	rewrittenPath: string;
	reason: string;
}

/** 符号链接逃逸防护：解析真实路径后再判定归属（design: 03 §8）。
 *  不存在的路径（新建文件）：解析到最近存在的祖先后拼回余下部分，
 *  避免一侧 realpath（如 macOS /var → /private/var）一侧词法路径的前缀失配。 */
function resolveExisting(p: string): string {
	const abs = resolve(p);
	let current = abs;
	const tail: string[] = [];
	for (;;) {
		try {
			return tail.length === 0 ? realpathSync(current) : join(realpathSync(current), ...tail);
		} catch {
			const parent = dirname(current);
			if (parent === current) return abs; // 到根仍不存在：退回词法路径
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

function isUnder(p: string, root: string): boolean {
	const rel = relative(root, p);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 路由一次"写"操作。
 * 规则（03 §3 路由表）：
 * - 目标在 worktree 内 → worktree
 * - 目标在 workspace 内 → policy.mode（inplace / worktree 重写进 worktreeRoot）
 * - 工作区外 → outsideWorkspace（temp-workspace 创建沙箱 / deny）
 */
export function routeWrite(target: string, ctx: RouteContext): RouteDecision {
	const wsRoot = resolveExisting(ctx.workspaceRoot);
	const abs = isAbsolute(target) ? resolveExisting(target) : resolveExisting(join(process.cwd(), target));

	if (ctx.worktreeRoot && isUnder(abs, resolveExisting(ctx.worktreeRoot))) {
		return { mode: "worktree", rewrittenPath: abs, reason: "目标位于 worktree 内" };
	}
	if (isUnder(abs, wsRoot)) {
		if (ctx.policy.mode === "worktree") {
			if (!ctx.worktreeRoot) {
				return { mode: "deny", rewrittenPath: abs, reason: "worktree 未创建（内部错误：worktreeRoot 缺失）" };
			}
			const rel = relative(wsRoot, abs);
			return {
				mode: "worktree",
				rewrittenPath: join(ctx.worktreeRoot, rel),
				reason: `工作区内写经 worktree（.${rel}）`,
			};
		}
		return { mode: "inplace", rewrittenPath: abs, reason: "工作区内直改（快照链追踪）" };
	}
	if (ctx.policy.outsideWorkspace === "temp-workspace") {
		return { mode: "temp-workspace", rewrittenPath: abs, reason: "工作区外文件 → 临时工作区" };
	}
	return { mode: "deny", rewrittenPath: abs, reason: "工作区外写入被策略拒绝（outsideWorkspace=deny）" };
}

/** bash 命令静态分析：提取高危模式（design: 03 §7.1 名单） */
const DANGEROUS_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rf]/, label: "递归/强制删除" },
	{ re: /\bgit\s+push\b[^&|;]*(--force|-f)\b/, label: "强制推送" },
	{ re: /\b(sudo|doas)\b/, label: "提权执行" },
	{ re: /\b(chmod|chown)\s+(-[a-zA-Z]+\s+)*777\b/, label: "全局可写权限" },
	{ re: /\bmkfs|dd\s+of=\/dev\//, label: "磁盘破坏" },
	{ re: /\bcurl[^|;]*\|\s*(ba)?sh\b/, label: "下载即执行" },
	{ re: /\bshutdown|reboot|killall\b/, label: "系统级命令" },
];

export interface BashAnalysis {
	dangerous: { label: string; matched: string }[];
	/** 命令中的绝对路径引用（~/ 展开、/ 开头 token） */
	absolutePaths: string[];
}

export function analyzeBash(command: string): BashAnalysis {
	const dangerous = DANGEROUS_PATTERNS.filter((p) => p.re.test(command)).map((p) => ({
		label: p.label,
		matched: command.match(p.re)?.[0] ?? "",
	}));
	const absolutePaths: string[] = [];
	for (const token of command.split(/\s+/)) {
		const t = token.replace(/^["']|["']$/g, "");
		if (t.startsWith("/") || t.startsWith("~/")) {
			absolutePaths.push(t.replace(/^~/, process.env.HOME ?? "~"));
		}
	}
	return { dangerous, absolutePaths };
}
