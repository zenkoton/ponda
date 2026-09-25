import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { paths } from "../src/paths.ts";
import { EnvNotFoundError } from "../src/resolve.ts";
import { EnvStore, ValidationError } from "../src/store.ts";

const homes: string[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-store-"));
	homes.push(h);
	return h;
}
afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("create/activate/list/info 生命周期", () => {
	const home = newHome();
	const store = new EnvStore(home);

	store.create({ name: "default", systemPrompt: "You are a helpful coding agent." });
	store.create({ name: "web-dev", base: "default", description: "web 开发", patch: { skills: ["react"] } });

	assert.equal(store.exists("web-dev"), true);
	assert.deepEqual(store.names(), ["default", "web-dev"]);

	store.activate("web-dev");
	assert.equal(store.readState().activeEnv, "web-dev");
	assert.ok(existsSync(join(paths.env(home, "web-dev"), "SYSTEM.md")));

	const list = store.list();
	assert.equal(list.filter((e) => e.active).length, 1);
	const web = list.find((e) => e.name === "web-dev");
	assert.equal(web?.base, "default");
	assert.equal(web?.skillCount, 1);

	const res = store.resolve("web-dev");
	assert.deepEqual(res.chain, ["web-dev", "default"]);
});

test("create 非法名/重名/缺 base", () => {
	const home = newHome();
	const store = new EnvStore(home);
	assert.throws(() => store.create({ name: "ENV" }), ValidationError);
	store.create({ name: "default" });
	assert.throws(() => store.create({ name: "default" }), ValidationError);
	assert.throws(() => store.create({ name: "x", base: "ghost" }), EnvNotFoundError);
});

test("remove：激活中拒绝；被继承默认拒绝、--force 改继父级；回收站", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.create({ name: "mid", base: "default" });
	store.create({ name: "leaf", base: "mid" });

	store.activate("default");
	assert.throws(() => store.remove("default"), ValidationError);

	assert.throws(() => store.remove("mid"), ValidationError); // 被 leaf 继承
	store.activate("default");
	store.remove("mid", { force: true });
	assert.equal(store.exists("mid"), false);
	assert.equal(store.readManifest("leaf")?.base, undefined); // 改继 default（隐式，不落字段）
	// 回收站（--force 也进回收站？设计：--force 跳过回收站 —— 此处 force 直接删除）
	const trash = join(paths.trash(home), "envs");
	assert.equal(existsSync(trash) && readdirSync(trash).length > 0, false);

	// 非 force 删除走回收站
	store.create({ name: "temp" });
	store.remove("temp");
	assert.ok(readdirSync(join(paths.trash(home), "envs")).some((n) => n.startsWith("temp-")));
});

test("rename：改状态、改引用方", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.create({ name: "web", base: "default" });
	store.create({ name: "child", base: "web" });
	store.activate("web");

	store.rename("web", "web2");
	assert.equal(store.exists("web"), false);
	assert.equal(store.readState().activeEnv, "web2");
	assert.equal(store.readManifest("child")?.base, "web2");
});

test("deactivate 清空激活", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.activate("default");
	store.deactivate();
	assert.equal(store.readState().activeEnv, null);
});

test("export/import 往返", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.create({ name: "web", description: "exp", patch: { skills: ["react"] } });
	const out = join(home, "export-out");
	store.exportEnv("web", out);

	const store2 = new EnvStore(newHome());
	store2.importEnv(out);
	assert.equal(store2.exists("web"), true);
	assert.equal(store2.resolve("web").effective.description, "exp");
});

test("doctor：漂移与断链检测", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.activate("default");

	// 手改渲染产物制造漂移
	writeFileSync(join(paths.env(home, "default"), "SYSTEM.md"), "tampered");

	// 制造断链
	const link = join(paths.env(home, "default"), "skills", "dead");
	symlinkSync("../../../resources/skills/nope", link);

	const report = store.doctor();
	assert.ok(report.some((r) => r.level === "warn" && r.message.includes("SYSTEM.md 与 manifest 漂移")));
	assert.ok(report.some((r) => r.message.includes("resources/skills/nope")));
});

test("diff：两个环境 effective 差异", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	store.create({ name: "web", patch: { runtime: { permissionMode: "plan" }, skills: ["react"] } });
	const d = store.diff("default", "web");
	const paths2 = d.map((x) => x.path);
	assert.ok(paths2.includes("runtime.permissionMode"));
	assert.ok(paths2.includes("skills"));
});

test("state.json 指向不存在环境 → doctor 报错", async () => {
	const home = newHome();
	const store = new EnvStore(home);
	const { writeFileSync: wf } = await import("node:fs");
	mkdirSync(home, { recursive: true });
	wf(paths.state(home), JSON.stringify({ activeEnv: "ghost" }));
	const report = store.doctor();
	assert.ok(report.some((r) => r.level === "error" && r.message.includes("ghost")));
	// readState 不应抛错
	assert.equal(store.readState().activeEnv, "ghost");
	rmSync(paths.state(home));
});
