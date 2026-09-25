import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { analyzeBash, routeWrite } from "../src/domains.ts";

const dirs: string[] = [];
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-sbx-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs.length = 0;
});

const POLICY = { mode: "inplace" as const, autoGitInit: true, outsideWorkspace: "temp-workspace" as const };

test("routeWrite：三域路由 + 符号链接逃逸防护", () => {
	const ws = newDir();
	const ctx = { workspaceRoot: ws, policy: POLICY };

	let r = routeWrite(join(ws, "src/a.ts"), ctx);
	assert.equal(r.mode, "inplace");

	// 符号链接指向工作区外 → 按真实路径判外
	const outside = newDir();
	writeFileSync(join(outside, "secret"), "x");
	symlinkSync(join(outside, "secret"), join(ws, "link"));
	r = routeWrite(join(ws, "link"), ctx);
	assert.equal(r.mode, "temp-workspace");

	// 工作区外 + deny
	r = routeWrite("/etc/nginx/nginx.conf", { ...ctx, policy: { ...POLICY, outsideWorkspace: "deny" } });
	assert.equal(r.mode, "deny");

	// worktree 模式：工作区内写重写进 worktree
	const wt = join(ws, ".ponda", "worktrees", "wt-1");
	r = routeWrite(join(ws, "src/b.ts"), {
		workspaceRoot: ws,
		policy: { ...POLICY, mode: "worktree" },
		worktreeRoot: wt,
	});
	assert.equal(r.mode, "worktree");
	assert.equal(r.rewrittenPath, join(wt, "src/b.ts"));
});

test("analyzeBash：高危模式与绝对路径提取", () => {
	const a1 = analyzeBash("rm -rf /tmp/x && echo done");
	assert.ok(a1.dangerous.some((d) => d.label.includes("删除")));
	const a2 = analyzeBash("git push --force origin main");
	assert.ok(a2.dangerous.some((d) => d.label.includes("推送")));
	const a3 = analyzeBash("npm test /abs/path ~/notes.txt");
	assert.deepEqual(a3.absolutePaths, ["/abs/path", join(process.env.HOME ?? "~", "notes.txt")]);
	assert.equal(analyzeBash("ls -la").dangerous.length, 0);
});
