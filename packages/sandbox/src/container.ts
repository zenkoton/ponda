/**
 * 容器后端（design: docs/design/03-sandbox.md §2.1；M3 余项，v1.1 用户决策）。
 * - ContainerBackend 抽象（docker | podman CLI 实现 + 测试用 Fake）
 * - bind-mount 清单按三域推导：workspace(rw)/worktree(仅该 worktree)/temp-workspace(rw)；
 *   工作区外路径一律不挂载（容器内不可见即不可写）
 * - overlayfs 上层 diff 审计通道：upperdir 递归扫描（.wh. 白障 → 删除），
 *   与 git 快照 diff 交叉比对——仅出现在 overlay 的写入单独列出
 * - 无容器降级链：confinement=audit-only 且高危命令默认拒绝
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeBash, type RouteContext, routeWrite } from "./domains.ts";

export interface ContainerBind {
	hostPath: string;
	containerPath: string;
	mode: "ro" | "rw";
}

export interface ContainerSpec {
	image: string;
	binds: ContainerBind[];
	network: "none" | "egress-policy";
	limits: { cpus: number; memoryMb: number; diskMb: number };
	/** 审计通道取证据路径（overlay upperdir，宿主侧） */
	overlayUpperDir: string;
}

export interface ContainerHandle {
	id: string;
	spec: ContainerSpec;
	stop(): Promise<{ ok: boolean; detail: string }>;
}

export interface ContainerBackend {
	id: "docker" | "podman" | "fake";
	run(spec: ContainerSpec, opts?: { name?: string }): Promise<ContainerHandle>;
}

export const DEFAULT_IMAGE = "ponda/sandbox:minimal";

// —— docker/podman CLI 参数构造（纯函数，可无运行时测试） ——

export function buildRunArgs(spec: ContainerSpec, name: string): string[] {
	const args = [
		"run",
		"-d",
		"--name",
		name,
		"--network",
		spec.network === "none" ? "none" : "bridge",
		"--cpus",
		String(spec.limits.cpus),
		"--memory",
		`${spec.limits.memoryMb}m`,
	];
	for (const b of spec.binds) {
		args.push("-v", `${b.hostPath}:${b.containerPath}:${b.mode}`);
	}
	// overlay 审计：upperdir/lowerdir 由运行时存储驱动提供，此处以卷挂载导出
	args.push("-v", `${spec.overlayUpperDir}:/audit/upper`);
	args.push(spec.image);
	return args;
}

export class DockerPodmanBackend implements ContainerBackend {
	readonly id: "docker" | "podman";
	private readonly bin?: string;

	constructor(id: "docker" | "podman", bin?: string) {
		this.id = id;
		this.bin = bin;
	}

	private cli(args: string[]): { ok: boolean; out: string } {
		const r = spawnSync(this.bin ?? this.id, args, { encoding: "utf8", timeout: 60000 });
		return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
	}

	async run(spec: ContainerSpec, opts: { name?: string } = {}): Promise<ContainerHandle> {
		const name = opts.name ?? `ponda-sbx-${randomUUID().slice(0, 8)}`;
		const r = this.cli(buildRunArgs(spec, name));
		if (!r.ok) throw new Error(`${this.id} run 失败：${r.out.slice(0, 300)}`);
		const backend = this;
		return {
			id: name,
			spec,
			async stop() {
				const s = backend.cli(["rm", "-f", name]);
				return { ok: s.ok, detail: s.out };
			},
		};
	}
}

/** 测试用假后端：记录 spec，可注入 overlay 写入 */
export class FakeBackend implements ContainerBackend {
	readonly id = "fake" as const;
	readonly specs: ContainerSpec[] = [];

	async run(spec: ContainerSpec, opts: { name?: string } = {}): Promise<ContainerHandle> {
		mkdirSync(spec.overlayUpperDir, { recursive: true });
		this.specs.push(spec);
		const stopped = { value: false };
		return {
			id: opts.name ?? `fake-${this.specs.length}`,
			spec,
			async stop() {
				stopped.value = true;
				return { ok: true, detail: "fake stopped" };
			},
		};
	}
}

/** 探测可用运行时（docker 优先；无则 null → audit-only 降级） */
export function detectBackend(): ContainerBackend | null {
	for (const bin of ["docker", "podman"]) {
		const r = spawnSync(bin, ["version", "--format", "{{.Client.Version}}"], { encoding: "utf8", timeout: 10000 });
		if (r.status === 0) return new DockerPodmanBackend(bin as "docker" | "podman", bin);
	}
	return null;
}

// —— bind-mount 三域推导（§2.1）——

export interface BindContext {
	workspaceRoot: string;
	/** worktree 模式：agent 实际根（仅挂它） */
	worktreeRoot?: string;
	/** 临时工作区目录（模式 C） */
	tempSandboxDir?: string;
}

export function deriveBinds(ctx: BindContext): ContainerBind[] {
	const binds: ContainerBind[] = [];
	if (ctx.worktreeRoot !== undefined && ctx.worktreeRoot !== ctx.workspaceRoot) {
		// worktree 模式：只挂 worktree（工作区其余部分不可见）
		binds.push({ hostPath: ctx.worktreeRoot, containerPath: "/workspace", mode: "rw" });
	} else {
		binds.push({ hostPath: ctx.workspaceRoot, containerPath: "/workspace", mode: "rw" });
	}
	if (ctx.tempSandboxDir !== undefined) {
		binds.push({ hostPath: ctx.tempSandboxDir, containerPath: "/sandbox", mode: "rw" });
	}
	return binds;
	// 工作区外路径不挂载即不可写（比路径重写更强的保证，§2.1）
}

// —— overlayfs 上层 diff 审计（§4 双通道 ①）——

export interface OverlayFileChange {
	path: string;
	kind: "A" | "M" | "D";
}

/** 递归扫描 upperdir；`.wh.<name>` 白障表示删除（overlayfs 语义） */
export function overlayUpperDiff(upperDir: string): OverlayFileChange[] {
	const out: OverlayFileChange[] = [];
	if (!existsSync(upperDir)) return out;
	const walk = (dir: string, prefix: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.name.startsWith(".wh.")) {
				out.push({ path: `${prefix}${e.name.slice(4)}`, kind: "D" });
				continue;
			}
			const rel = `${prefix}${e.name}`;
			if (e.isDirectory()) walk(join(dir, e.name), `${rel}/`);
			else out.push({ path: rel, kind: "A" });
		}
	};
	walk(upperDir, "");
	return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface CrossAuditReport {
	both: string[];
	overlayOnly: string[];
	gitOnly: string[];
}

/** overlay 与 git 快照 diff 交叉比对（§6.2 双证据；仅 overlay 的写入单独列出） */
export function crossAudit(
	overlay: OverlayFileChange[],
	gitDiff: { status: string; path: string }[],
): CrossAuditReport {
	const overlaySet = new Set(overlay.map((o) => o.path));
	const gitSet = new Set(gitDiff.map((g) => g.path));
	return {
		both: [...overlaySet].filter((p) => gitSet.has(p)).sort(),
		overlayOnly: [...overlaySet].filter((p) => !gitSet.has(p)).sort(),
		gitOnly: [...gitSet].filter((p) => !overlaySet.has(p)).sort(),
	};
}

// —— 会话容器管理（每会话容器 + 降级链）——

export interface EnsureResult {
	confinement: "container" | "audit-only";
	handle?: ContainerHandle;
	/** 降级原因（backend 缺失/启动失败） */
	downgradeReason?: string;
}

export interface CommandGuardResult {
	allowed: boolean;
	reason: string;
	/** 容器模式给出执行入口（P4 后由 bash 工具在容器内执行） */
	inContainer: boolean;
}

export class SessionContainerManager {
	private readonly handles = new Map<string, ContainerHandle>();
	private readonly confinement = new Map<string, "container" | "audit-only">();

	private readonly backend: ContainerBackend | null;
	private readonly opts: { upperDirRoot: string; image?: string };

	constructor(
		backend: ContainerBackend | null,
		opts: { upperDirRoot: string; image?: string } = { upperDirRoot: "" },
	) {
		this.backend = backend;
		this.opts = opts;
	}

	status(sessionId: string): "container" | "audit-only" | "none" {
		return this.confinement.get(sessionId) ?? "none";
	}

	/** 每会话容器：按三域推导 binds；backend 缺失/失败 → audit-only 降级（§2.1 降级链） */
	async ensure(sessionId: string, ctx: RouteContext & { tempSandboxDir?: string }): Promise<EnsureResult> {
		const existing = this.handles.get(sessionId);
		if (existing !== undefined) return { confinement: "container", handle: existing };
		if (this.backend === null) {
			this.confinement.set(sessionId, "audit-only");
			return { confinement: "audit-only", downgradeReason: "无容器运行时（docker/podman 未检测到）" };
		}
		// 三域路由（domains.routeWrite 的挂载语义而非路径重写）
		const probe = routeWrite(join(ctx.workspaceRoot, ".ponda-probe"), ctx);
		void probe;
		const binds = deriveBinds({
			workspaceRoot: ctx.workspaceRoot,
			worktreeRoot: ctx.worktreeRoot,
			tempSandboxDir: ctx.tempSandboxDir,
		});
		const overlayUpperDir = join(this.opts.upperDirRoot, sessionId, "upper");
		const spec: ContainerSpec = {
			image: this.opts.image ?? DEFAULT_IMAGE,
			binds,
			network: "none",
			limits: { cpus: 2, memoryMb: 2048, diskMb: 10240 },
			overlayUpperDir,
		};
		try {
			const handle = await this.backend.run(spec, { name: `ponda-${sessionId.slice(0, 8)}` });
			this.handles.set(sessionId, handle);
			this.confinement.set(sessionId, "container");
			return { confinement: "container", handle };
		} catch (e) {
			this.confinement.set(sessionId, "audit-only");
			return {
				confinement: "audit-only",
				downgradeReason: `容器启动失败：${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	/**
	 * 高危命令守卫（§2.1 降态收紧 / §7.1）：
	 * - container：bash 被 confined，高危命令允许（在容器内执行）
	 * - audit-only：高危命令默认拒绝
	 */
	guardCommand(sessionId: string, command: string): CommandGuardResult {
		const mode = this.confinement.get(sessionId);
		const analysis = analyzeBash(command);
		if (mode === "container") {
			return { allowed: true, reason: "容器内执行（confined）", inContainer: true };
		}
		if (analysis.dangerous.length > 0) {
			return {
				allowed: false,
				reason: `audit-only 降级态：高危命令默认拒绝（${analysis.dangerous.map((d) => d.label).join("、")}）`,
				inContainer: false,
			};
		}
		return { allowed: true, reason: "非高危命令，audit-only 放行（git 快照兜底）", inContainer: false };
	}

	/** 结算审计：overlay diff 与 git 快照交叉比对（§6.2） */
	settleAudit(sessionId: string, gitDiff: { status: string; path: string }[]): CrossAuditReport {
		const handle = this.handles.get(sessionId);
		const upper =
			handle !== undefined ? handle.spec.overlayUpperDir : join(this.opts.upperDirRoot, sessionId, "upper");
		return crossAudit(overlayUpperDiff(upper), gitDiff);
	}

	async stop(sessionId: string): Promise<void> {
		const h = this.handles.get(sessionId);
		if (h !== undefined) {
			await h.stop();
			this.handles.delete(sessionId);
		}
		this.confinement.delete(sessionId);
	}
}
