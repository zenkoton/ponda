/**
 * 模式 A inplace 沙箱管线（design: 03 §5.2/§6）：
 * - turn_end 快照链：真实循环（write 工具）后 ponda/snapshots/<session> 出现
 *   `ponda: auto: turn <n>`，活动状态 pending→dirty→snapped，activities.json 落盘
 * - SandboxActivity 状态机：结算 committed / 回滚 rolledback
 * - 结算 commit 规范：ponda(<task|session>): <摘要>
 * - rollbackTo：turn n / baseline；空轮不提交空快照
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods } from "../../rpc/src/index.ts";
import { snapshotLog } from "../../sandbox/src/gitops.ts";
import { DaemonCore } from "../src/core.ts";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../src/pi-loop.ts";
import { InplaceSandboxTracker } from "../src/sandbox-session.ts";

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const fauxes: FauxProviderRegistration[] = [];
function newDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const f of fauxes.splice(0)) f.unregister();
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

function gitInit(ws: string): void {
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: ws });
}

test("turn_end 快照链：真实循环写文件后产生 auto: turn 1 快照，活动状态迁移", async () => {
	const home = newDir("ponda-isa-");
	const ws = newDir("ponda-isa-ws-");
	writeFileSync(join(ws, "seed.txt"), "base\n");
	gitInit(ws);

	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "hello.txt", content: "changed" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("完成"),
	]);

	const core = new DaemonCore({ home, env: "web", piModel: { modelId: "faux-1", faux } });
	cores.push(core);
	await core.start();
	const c = new RpcClient();
	await c.connect(core.socketPath());
	const created = await c.request<{ sessionId: string }>(Methods.sessionNew, { workspace: ws });
	await c.request(Methods.sessionSend, { sessionId: created.sessionId, text: "写文件" });
	for (let i = 0; i < 150; i++) {
		const l = await c.request<{ processing: boolean }[]>(Methods.sessionList);
		if (l[0]?.processing === false) break;
		await new Promise((r) => setTimeout(r, 20));
	}

	// 快照链：变更未结算则每轮续拍（03 §5.2"有变更则提交"）；message 规范 auto: turn <n>
	const log = snapshotLog(ws, created.sessionId.slice(0, 8));
	assert.equal(log.length, 1, `同内容轮去重后仅 1 拍（实际 ${log.length}）`);
	assert.ok(
		log.some((e) => e.message === "ponda: auto: turn 1"),
		`message 规范 auto: turn <n>（实际：${log.map((e) => e.message).join(" | ")}）`,
	);
	// 活动状态机 + 落盘
	const act = core.sandboxTracker.get(created.sessionId);
	assert.ok(act !== null);
	assert.equal(act.state, "snapped");
	assert.equal(act.turns, 1, "同内容轮去重：仅真实状态跃迁拍快照");
	assert.ok(act.baseline !== null, "baseline 记录");
	assert.ok(existsSync(join(home, "envs", "web", "state", "sandbox-activities.json")), "活动持久化落盘");
	// 工作区文件确实被修改（未结算，仍在工作区）
	assert.equal(readFileSync(join(ws, "hello.txt"), "utf8"), "changed");
});

test("tracker：结算 commit 规范 / rollback turn / rollback baseline / 空轮跳过", () => {
	const home = newDir("ponda-isa2-");
	const ws = newDir("ponda-isa2-ws-");
	writeFileSync(join(ws, "seed.txt"), "base\n");
	gitInit(ws);
	const stateFile = join(home, "state.json");
	const tracker = new InplaceSandboxTracker(stateFile);

	// ensure：已是 git 仓库，baseline = HEAD
	const act = tracker.ensure("sess-aaaa-bbbb", ws, { autoGitInit: true });
	assert.ok(act !== null);
	assert.equal(act.state, "pending");

	// 空轮：无变更不快照
	assert.equal(tracker.snapshotTurn("sess-aaaa-bbbb", ws), null, "空轮跳过");
	assert.equal(tracker.get("sess-aaaa-bbbb")?.turns, 0);

	// 第 1 轮：修改已跟踪文件 → 快照（回滚语义按 git reset --hard = 已跟踪文件口径）
	writeFileSync(join(ws, "seed.txt"), "v1\n");
	const s1 = tracker.snapshotTurn("sess-aaaa-bbbb", ws);
	assert.ok(s1 !== null && s1.turn === 1);
	// 第 2 轮再改 → 快照 2
	writeFileSync(join(ws, "seed.txt"), "v2\n");
	const s2 = tracker.snapshotTurn("sess-aaaa-bbbb", ws);
	assert.ok(s2 !== null && s2.turn === 2);
	assert.equal(snapshotLog(ws, "sess-aaa")[0]?.message, "ponda: auto: turn 2");

	// 回滚到 turn 1：seed.txt 内容回到 v1
	const rb = tracker.rollbackTo("sess-aaaa-bbbb", { turn: 1 });
	assert.ok(rb.ok, rb.detail);
	assert.equal(readFileSync(join(ws, "seed.txt"), "utf8"), "v1\n", "已跟踪内容回到 turn 1");
	assert.equal(tracker.get("sess-aaaa-bbbb")?.state, "rolledback");

	// 结算：规范 message ponda(<task>): <摘要>
	writeFileSync(join(ws, "final.txt"), "f\n");
	const st = tracker.settle("sess-aaaa-bbbb", "补全 README", { taskId: "task-1a2b3c4d" });
	assert.ok(st.ok, st.detail);
	assert.ok(st.detail.startsWith("ponda(task-1a2): 补全 README"), `commit 规范：${st.detail}`);
	assert.equal(tracker.get("sess-aaaa-bbbb")?.state, "committed");
	// git log 顶部是规范提交
	const logHead = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: ws, encoding: "utf8" }).trim();
	assert.equal(logHead, "ponda(task-1a2): 补全 README");

	// baseline 回滚：seed.txt 回到 base
	const rbBase = tracker.rollbackTo("sess-aaaa-bbbb", { baseline: true });
	assert.ok(rbBase.ok, rbBase.detail);
	assert.equal(readFileSync(join(ws, "seed.txt"), "utf8"), "base\n", "回到 baseline");

	// 状态文件重载（daemon 重启语义）
	const tracker2 = new InplaceSandboxTracker(stateFile);
	assert.equal(tracker2.get("sess-aaaa-bbbb")?.turns, 2, "活动跨实例恢复");
});
