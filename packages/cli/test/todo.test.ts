/** `ponda todo ls`（design: 05 §2：CLI 与 TUI 右栏共享看板；RPC todo.list/todo.read） */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string): { code: number; out: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1" },
			encoding: "utf8",
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

test("ponda todo ls：空看板提示 + JSON 输出可用", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-todo-"));
	homes.push(home);
	const init = run(["init"], home);
	assert.equal(init.code, 0);

	const r = run(["todo", "ls"], home);
	assert.equal(r.code, 0, `todo ls 成功（输出：${r.out.slice(0, 200)}）`);
	assert.ok(r.out.includes("暂无看板") || r.out.includes("看板"), "空看板提示");

	const j = run(["todo", "ls", "--json"], home);
	assert.equal(j.code, 0);
	JSON.parse(j.out); // 合法 JSON
});
