import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	buildRunArgs,
	type ContainerSpec,
	crossAudit,
	DockerPodmanBackend,
	deriveBinds,
	detectBackend,
	FakeBackend,
	overlayUpperDiff,
	SessionContainerManager,
} from "../src/container.ts";

const dirs: string[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-ctr-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SPEC = (upper: string): ContainerSpec => ({
	image: "ponda/sandbox:minimal",
	binds: [{ hostPath: "/ws", containerPath: "/workspace", mode: "rw" }],
	network: "none",
	limits: { cpus: 2, memoryMb: 2048, diskMb: 10240 },
	overlayUpperDir: upper,
});

test("buildRunArgs：docker CLI 参数（挂载/网络/资源限额/审计卷）", () => {
	const args = buildRunArgs(SPEC("/upper"), "ponda-abc");
	assert.deepEqual(
		args.filter((a) => a === "--network" || a === "none"),
		["--network", "none"],
	);
	assert.ok(args.includes("/ws:/workspace:rw"), "bind 挂载");
	assert.ok(args.includes("/upper:/audit/upper"), "overlay 审计卷");
	assert.ok(args.includes("--cpus") && args.includes("2"));
	assert.ok(args.includes("--memory") && args.includes("2048m"));
	assert.ok(args.at(-1) === "ponda/sandbox:minimal");
});

test("deriveBinds：三域推导（inplace 挂工作区 / worktree 只挂 worktree / temp 附加；区外不挂）", () => {
	const ws = newDir();
	const wt = join(ws, ".ponda", "worktrees", "wt-1");
	const temp = newDir();

	let binds = deriveBinds({ workspaceRoot: ws });
	assert.deepEqual(binds, [{ hostPath: ws, containerPath: "/workspace", mode: "rw" }]);

	binds = deriveBinds({ workspaceRoot: ws, worktreeRoot: wt });
	assert.deepEqual(binds, [{ hostPath: wt, containerPath: "/workspace", mode: "rw" }], "worktree 模式只挂 worktree");

	binds = deriveBinds({ workspaceRoot: ws, tempSandboxDir: temp });
	assert.equal(binds.length, 2);
	assert.ok(binds.some((b) => b.hostPath === temp && b.containerPath === "/sandbox" && b.mode === "rw"));
	// 工作区外路径（如 /etc）从不出现在挂载清单
	assert.ok(!binds.some((b) => b.hostPath === "/etc"));
});

test("overlayUpperDiff：新增/白障删除识别", () => {
	const upper = newDir();
	mkdirSync(join(upper, "src"), { recursive: true });
	writeFileSync(join(upper, "src", "a.ts"), "x");
	writeFileSync(join(upper, "src", ".wh.deleted.ts"), "");
	writeFileSync(join(upper, "new.txt"), "y");
	const diff = overlayUpperDiff(upper);
	assert.deepEqual(diff, [
		{ path: "new.txt", kind: "A" },
		{ path: "src/a.ts", kind: "A" },
		{ path: "src/deleted.ts", kind: "D" },
	]);
	assert.deepEqual(overlayUpperDiff(join(newDir(), "不存在")), []);
});

test("crossAudit：overlay 与 git 快照交叉（仅 overlay 的写入单独列出）", () => {
	const report = crossAudit(
		[
			{ path: "src/both.ts", kind: "A" },
			{ path: "ignored.log", kind: "A" },
		],
		[
			{ status: "A", path: "src/both.ts" },
			{ status: "M", path: "src/git-only.ts" },
		],
	);
	assert.deepEqual(report.both, ["src/both.ts"]);
	assert.deepEqual(report.overlayOnly, ["ignored.log"], "git 忽略路径的写入被审计捕获");
	assert.deepEqual(report.gitOnly, ["src/git-only.ts"]);
});

test("每会话容器：Fake 后端生命周期 + 复用", async () => {
	const root = newDir();
	const backend = new FakeBackend();
	const mgr = new SessionContainerManager(backend, { upperDirRoot: root });
	const ws = newDir();
	const r1 = await mgr.ensure("sess-1", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	assert.equal(r1.confinement, "container");
	assert.equal(backend.specs.length, 1);
	assert.equal(backend.specs[0]?.binds[0]?.hostPath, ws);
	assert.ok(backend.specs[0]?.overlayUpperDir.includes(join(root, "sess-1")));
	// 幂等复用
	const r2 = await mgr.ensure("sess-1", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	assert.equal(r2.handle?.id, r1.handle?.id);
	assert.equal(backend.specs.length, 1);
	await mgr.stop("sess-1");
	assert.equal(mgr.status("sess-1"), "none");
});

test("降级链：无后端 → audit-only；高危命令默认拒绝、普通命令放行", async () => {
	const root = newDir();
	const mgr = new SessionContainerManager(null, { upperDirRoot: root });
	const ws = newDir();
	const r = await mgr.ensure("sess-2", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	assert.equal(r.confinement, "audit-only");
	assert.ok((r.downgradeReason ?? "").includes("无容器运行时"));

	const deny = mgr.guardCommand("sess-2", "rm -rf /tmp/x");
	assert.equal(deny.allowed, false);
	assert.ok(deny.reason.includes("默认拒绝"), deny.reason);

	const allow = mgr.guardCommand("sess-2", "npm test");
	assert.equal(allow.allowed, true);
	assert.equal(allow.inContainer, false);
});

test("容器模式：高危命令允许（confined，容器内执行）", async () => {
	const root = newDir();
	const mgr = new SessionContainerManager(new FakeBackend(), { upperDirRoot: root });
	const ws = newDir();
	await mgr.ensure("sess-3", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	const g = mgr.guardCommand("sess-3", "git push --force origin main");
	assert.equal(g.allowed, true);
	assert.equal(g.inContainer, true);
});

test("结算审计：overlay×git 交叉经会话管理器输出", async () => {
	const root = newDir();
	const backend = new FakeBackend();
	const mgr = new SessionContainerManager(backend, { upperDirRoot: root });
	const ws = newDir();
	const r = await mgr.ensure("sess-4", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	// 模拟容器内写：向 upperdir 落两个文件（其一在 git 忽略路径）
	const upper = (r.handle?.spec.overlayUpperDir ?? "") as string;
	mkdirSync(join(upper, "dist"), { recursive: true });
	writeFileSync(join(upper, "dist", "bundle.js"), "x");
	writeFileSync(join(upper, "tracked.ts"), "y");
	const report = mgr.settleAudit("sess-4", [{ status: "A", path: "tracked.ts" }]);
	assert.deepEqual(report.both, ["tracked.ts"]);
	assert.deepEqual(report.overlayOnly, ["dist/bundle.js"], "git 未追踪的写入单独列出");
	await mgr.stop("sess-4");
});

test("detectBackend：本机探测不抛错（有/无运行时均返回合法结果）", () => {
	const b = detectBackend();
	assert.ok(b === null || b.id === "docker" || b.id === "podman");
});

test("DockerPodmanBackend：运行失败时 ensure 降级 audit-only", async () => {
	const root = newDir();
	// 指向不存在的二进制 → run 抛错
	const broken = new DockerPodmanBackend("docker", "/nonexistent/docker-bin");
	const mgr = new SessionContainerManager(broken, { upperDirRoot: root });
	const ws = newDir();
	const r = await mgr.ensure("sess-5", {
		workspaceRoot: ws,
		policy: { mode: "inplace", autoGitInit: false, outsideWorkspace: "temp-workspace" },
	});
	assert.equal(r.confinement, "audit-only");
	assert.ok((r.downgradeReason ?? "").includes("容器启动失败"));
	// 降级后高危命令拒绝
	assert.equal(mgr.guardCommand("sess-5", "mkfs /dev/disk0").allowed, false);
});

// git 可用性冒烟（本机 git 一直可用；保留以约束环境）
test("环境：git 可用（容器审计依赖）", () => {
	const r = execFileSync("git", ["--version"], { encoding: "utf8" });
	assert.ok(r.includes("git version"));
});
