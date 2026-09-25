/** `ponda sandbox snapshots/commit/rollback` CLI：快照链查看 + 结算/回滚的确认门（03 §6.3 无旁路） */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { InplaceSandboxTracker } from "../../daemon/src/sandbox-session.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string, cwd?: string): { code: number; out: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1" },
			encoding: "utf8",
			cwd,
		});
		return { code: 0, out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string };
		return { code: err.status ?? 1, out: err.stdout ?? "" };
	}
}

afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("sandbox snapshots 列出快照链；commit/rollback 非 TTY 拒绝（exit 4）", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-sbx-"));
	homes.push(home);
	const ws = mkdtempSync(join(tmpdir(), "ponda-sbx-ws-"));
	writeFileSync(join(ws, "seed.txt"), "base\n");
	execFileSync("git", ["init", "-q"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], { cwd: ws });

	// 直接经 tracker 造一拍快照（daemon 在真实链路中做同样的事）
	const tracker = new InplaceSandboxTracker(join(home, "envs", "default", "state", "sandbox-activities.json"));
	tracker.ensure("sess-abcd1234-xxxx", ws, { autoGitInit: true });
	writeFileSync(join(ws, "change.txt"), "v1\n");
	const snap = tracker.snapshotTurn("sess-abcd1234-xxxx", ws);
	assert.ok(snap !== null);

	// snapshots：默认环境（init 建 default）列出快照
	assert.equal(run(["init"], home).code, 0);
	// tracker 的状态文件在 init 前写的（目录已存在）——重跑一次让 CLI 读到
	const list = run(["sandbox", "snapshots"], home);
	assert.equal(list.code, 0, list.out);
	assert.ok(list.out.includes("auto: turn 1"), `快照列出：${list.out}`);

	// commit：非 TTY → exit 4（03 §6.3 无 --yes 旁路）
	const commit = run(["sandbox", "commit", "补全功能"], home);
	assert.equal(commit.code, 4, `非 TTY 拒绝（输出：${commit.out}）`);

	// rollback：非 TTY → exit 4
	const rb = run(["sandbox", "rollback", "1"], home);
	assert.equal(rb.code, 4, `非 TTY 拒绝（输出：${rb.out}）`);
});
