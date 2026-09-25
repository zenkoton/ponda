import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "src", "bin.ts");
const homes: string[] = [];

function run(args: string[], home: string): { code: number; out: string; err: string } {
	try {
		const out = execFileSync(process.execPath, [BIN, ...args], {
			env: { ...process.env, PONDA_HOME: home, NO_COLOR: "1" },
			encoding: "utf8",
		});
		return { code: 0, out, err: "" };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return { code: err.status ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
	}
}

afterEach(() => {
	for (const h of homes) rmSync(h, { recursive: true, force: true });
	homes.length = 0;
});

test("M2 端到端：skills/tools/provider/免切换/memory/history", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-m2cli-"));
	homes.push(home);

	assert.equal(run(["init"], home).code, 0);

	// 本地 skill 安装 + 启用 + 软链接
	const src = join(home, "my-skill");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "---\ndescription: mine\n---\nbody");
	let r = run(["skills", "add", src, "mine"], home);
	assert.equal(r.code, 0, r.err);
	assert.ok(existsSync(join(home, "envs/default/skills/mine")), "软链接应存在");

	// --available 视图
	r = run(["skills", "list", "--available"], home);
	assert.ok(r.out.includes("mine"));

	// 内联 command 工具
	r = run(["tools", "add", "deploy", "--command", "./d.sh $ARGUMENTS", "--desc", "deploy it"], home);
	assert.equal(r.code, 0, r.err);
	r = run(["tools", "list"], home);
	assert.ok(r.out.includes("deploy"));

	// provider（$ENV 密钥引用）+ 渲染 models.json
	r = run(
		[
			"provider",
			"add",
			"glh",
			"--base-url",
			"https://api.test/v1",
			"--api",
			"openai-completions",
			"--model",
			"m1,m2",
			"--api-key",
			"$GLM_KEY",
		],
		home,
	);
	assert.equal(r.code, 0, r.err);
	assert.ok(existsSync(join(home, "envs/default/models.json")));
	r = run(["model", "list"], home);
	assert.ok(r.out.includes("glm".replace("m", "m")) || r.out.includes("m1"));

	// 免切换语法：ponda default skills list == skills list --env default
	run(["env", "create", "web"], home);
	r = run(["default", "skills", "list"], home);
	assert.ok(r.out.includes("mine"), "免切换应看到 default 环境启用的 skill");
	r = run(["web", "skills", "list"], home);
	assert.ok(r.out.includes("mine"), "web 继承 default 也应看到");

	// memory reset
	r = run(["memory", "reset"], home);
	assert.equal(r.code, 0, r.err);

	// history：造一个 pi 会话
	const sessions = join(home, "envs/web/sessions");
	writeFileSync(
		join(sessions, "h1.jsonl"),
		[
			JSON.stringify({ type: "session", id: "h1", cwd: "/w", timestamp: "2026-09-25T10:00:00.000Z" }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-09-25T10:00:01.000Z",
				message: { role: "user", content: "重构登录" },
			}),
		].join("\n"),
	);
	r = run(["history", "list"], home);
	assert.ok(r.out.includes("h1"));
	r = run(["history", "search", "登录"], home);
	assert.ok(r.out.includes("h1"));
	r = run(["history", "info", "h1", "--json"], home);
	assert.ok(JSON.parse(r.out).workspace === "/w");
	r = run(["history", "attach", "h1"], home);
	assert.ok(r.out.includes("web"));
});

test("rm --purge 引用保护：其他环境显式启用时拒绝删除", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-m2cli-"));
	homes.push(home);
	run(["init"], home);
	const src = join(home, "s");
	mkdirSync(src, { recursive: true });
	writeFileSync(join(src, "SKILL.md"), "# s");
	run(["skills", "add", src, "shared"], home); // default 启用
	run(["env", "create", "web"], home);
	run(["web", "skills", "add", "shared"], home); // web 显式启用（非仅继承）
	// default 停用后，web 的显式引用仍在 → purge 拒绝
	const r = run(["skills", "rm", "shared", "--purge"], home);
	assert.equal(r.code, 4);
	assert.ok(r.err.includes("web"));
});

test("凭据隔离：明文 --api-key 存 auth.json（0600），manifest/models.json 无明文", () => {
	const home = mkdtempSync(join(tmpdir(), "ponda-cred-"));
	homes.push(home);
	assert.equal(run(["init"], home).code, 0);

	const r = run(
		[
			"provider",
			"add",
			"sec",
			"--base-url",
			"https://api.test/v1",
			"--api",
			"openai-completions",
			"--model",
			"m1",
			"--api-key",
			"sk-plain-secret",
		],
		home,
	);
	assert.equal(r.code, 0, r.err);
	assert.ok(r.out.includes("auth.json"), "输出说明凭据去向");

	// auth.json：0600 + 明文
	const authFile = join(home, "envs", "default", "auth.json");
	assert.ok(existsSync(authFile), "auth.json 存在");
	assert.equal(statSync(authFile).mode & 0o777, 0o600, "0600");
	assert.ok(readFileSync(authFile, "utf8").includes("sk-plain-secret"));

	// manifest 与渲染产物无明文
	const manifest = readFileSync(join(home, "envs", "default", "manifest.json"), "utf8");
	assert.ok(!manifest.includes("sk-plain-secret"), "manifest 无明文");
	const modelsJson = readFileSync(join(home, "envs", "default", "models.json"), "utf8");
	assert.ok(!modelsJson.includes("sk-plain-secret"), "models.json 无明文");

	// 池内 provider.json 也无明文（provider 池目录 = resources/models，02 §4 表格）
	const poolDir = join(home, "resources", "models");
	const poolFile = join(poolDir, readdirSync(poolDir).find((d) => d.startsWith("sec@")) ?? "", "provider.json");
	assert.ok(!readFileSync(poolFile, "utf8").includes("sk-plain-secret"), "池无明文");

	// provider list 凭据列显示 auth.json（不再出现 明文⚠）
	const list = run(["provider", "list"], home);
	assert.ok(list.out.includes("auth.json"), "KEY 列显示 auth.json");
	assert.ok(!list.out.includes("明文"), "不再提示明文风险");
});
