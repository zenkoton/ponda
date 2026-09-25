import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DaemonCore } from "../../daemon/src/core.ts";
import { RpcClient } from "../../rpc/src/client.ts";
import { Methods, type TaskInfo } from "../../rpc/src/index.ts";
import { PondaTui } from "../../tui-next/src/app/app.ts";
import { VirtualTerminal } from "../../tui-next/test/virtual-terminal.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");

const cleanups: (() => void)[] = [];
const cores: DaemonCore[] = [];
const apps: PondaTui[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-m6-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}
afterEach(async () => {
	for (const a of apps.splice(0)) await a.stop().catch(() => {});
	for (const c of cores.splice(0)) await c.shutdown(0).catch(() => {});
	for (const c of cleanups.splice(0)) c();
});

test("TUI 端到端：右栏成果状态 + 契约确认弹窗 + 变更审批弹窗", async () => {
	const home = newDir();
	const ws = newDir();
	const core = new DaemonCore({ home, env: "web" });
	cores.push(core);
	await core.start();

	const ctl = new RpcClient();
	await ctl.connect(core.socketPath());

	const term = new VirtualTerminal(110, 34);
	const frames: string[][] = [];
	const client = new RpcClient();
	await client.connect(core.socketPath());
	const app = new PondaTui({
		env: "web",
		home,
		client,
		terminal: term,
		pollMs: 60000,
		onFrame: (lines) => frames.push(lines.map(stripAnsi)),
	});
	apps.push(app);
	await app.start();
	const has = (pred: (f: string[]) => boolean) => frames.some(pred);
	const waitFrame = async (pred: (f: string[]) => boolean, ms = 4000): Promise<void> => {
		for (let i = 0; i < ms / 20 && !has(pred); i++) await new Promise((r) => setTimeout(r, 20));
	};

	// 1) 创建 planning 任务 → 契约确认弹窗自动出现
	const started = await ctl.request<TaskInfo>(Methods.taskStart, {
		goal: "M6 演示目标",
		workspace: ws,
		deliverables: [
			{
				id: "d1",
				name: "导出命令",
				description: "CLI 有 export 子命令",
				doneCriteria: "export 可运行",
				verify: { type: "command", command: "true" },
				status: "planned",
			},
		],
	});
	await waitFrame((f) => f.some((l) => l.includes("成果契约确认")));
	assert.ok(
		has((f) => f.some((l) => l.includes("M6 演示目标"))),
		"弹窗含目标",
	);
	assert.ok(
		has((f) => f.some((l) => l.includes("[Enter] 确认冻结"))),
		"确认键提示",
	);
	// 右栏 goal 区块
	assert.ok(
		has((f) => f.some((l) => l.includes("goal"))),
		"右栏 goal 区块",
	);
	assert.ok(
		has((f) => f.some((l) => l.includes("d1 导出命令"))),
		"右栏成果行",
	);

	// 2) Enter 确认 → executing（taskEvents 驱动刷新）
	app.handleInput("\r");
	await waitFrame((f) => f.some((l) => l.includes("executing")));
	assert.ok(
		has((f) => f.some((l) => l.includes("executing"))),
		"确认后进入 executing",
	);

	// 3) 变更申请 → 审批弹窗 → y 批准 → v1
	await ctl.request(Methods.taskChangeRequest, {
		taskId: started.taskId,
		changes: [
			{
				op: "modify",
				deliverable: {
					id: "d1",
					name: "导出命令v2",
					description: "",
					doneCriteria: "更强",
					verify: { type: "command", command: "true" },
					status: "planned",
				},
				reason: "需求升级",
			},
		],
	});
	await waitFrame((f) => f.some((l) => l.includes("契约变更审批")));
	assert.ok(
		has((f) => f.some((l) => l.includes("需求升级"))),
		"弹窗含变更理由",
	);
	app.handleInput("y");
	await waitFrame((f) => f.some((l) => l.includes("v1")));
	const st = await ctl.request<{ tasks: TaskInfo[] }>(Methods.taskStatus, { taskId: started.taskId });
	assert.equal(st.tasks[0]?.contractRevision, 1, "RPC 侧修订为 1");

	// 4) verify → settled → 右栏 ✔
	await ctl.request(Methods.taskVerify, { taskId: started.taskId });
	await waitFrame((f) => f.some((l) => l.includes("settled")));
	assert.ok(
		has((f) => f.some((l) => l.includes("✔ d1"))),
		"右栏成果 ✔",
	);

	ctl.close();
});
