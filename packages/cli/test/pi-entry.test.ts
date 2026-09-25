import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

/**
 * P1 入口补丁护栏（PATCHES.md）：pi 原生读取 ponda state.json 定位环境 agent dir。
 * 优先级：PI_CODING_AGENT_DIR 显式覆盖 > ponda state.json > pi 默认目录。
 * 直接锁定源码 config.ts（上游重构触碰该点时此测试立即报警）；
 * e2e 用例另经构建产物 dist/bundle/cli.js 验证真实入口行为。
 */
const config = await import("../../coding-agent/src/config.ts");
const getAgentDir = config.getAgentDir as () => string;
const PI_BIN = join(import.meta.dirname, "..", "..", "coding-agent", "dist", "bundle", "cli.js");

const dirs: string[] = [];
function newPondaHome(activeEnv?: string, createEnv = true): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-p1-"));
	dirs.push(h);
	if (activeEnv !== undefined) {
		writeFileSync(join(h, "state.json"), JSON.stringify({ activeEnv }));
		if (createEnv) mkdirSync(join(h, "envs", activeEnv), { recursive: true });
	}
	return h;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries(env)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

test("护栏：显式 PI_CODING_AGENT_DIR 覆盖一切", () => {
	const home = newPondaHome("web-dev");
	withEnv({ PI_CODING_AGENT_DIR: "/explicit/override", PONDA_HOME: home }, () => {
		assert.equal(getAgentDir(), "/explicit/override");
	});
});

test("护栏：PONDA_HOME + state.json → 环境目录（P1 原生路径）", () => {
	const home = newPondaHome("web-dev");
	withEnv({ PI_CODING_AGENT_DIR: undefined, PONDA_HOME: home }, () => {
		assert.equal(getAgentDir(), join(home, "envs", "web-dev"));
	});
});

test("护栏：无 state / 坏 state / 环境目录缺失 → 回落 pi 默认", () => {
	const none = newPondaHome();
	withEnv({ PI_CODING_AGENT_DIR: undefined, PONDA_HOME: none }, () => {
		assert.equal(getAgentDir(), join(process.env.HOME ?? "~", ".pi", "agent"));
	});
	const bad = newPondaHome();
	writeFileSync(join(bad, "state.json"), "{broken json");
	withEnv({ PI_CODING_AGENT_DIR: undefined, PONDA_HOME: bad }, () => {
		assert.equal(getAgentDir(), join(process.env.HOME ?? "~", ".pi", "agent"));
	});
	const missingEnv = newPondaHome("ghost", false);
	withEnv({ PI_CODING_AGENT_DIR: undefined, PONDA_HOME: missingEnv }, () => {
		assert.equal(getAgentDir(), join(process.env.HOME ?? "~", ".pi", "agent"));
	});
});

test("护栏：state.activeEnv 为空 → 回落默认", () => {
	const home = newPondaHome();
	writeFileSync(join(home, "state.json"), JSON.stringify({ activeEnv: null }));
	withEnv({ PI_CODING_AGENT_DIR: undefined, PONDA_HOME: home }, () => {
		assert.equal(getAgentDir(), join(process.env.HOME ?? "~", ".pi", "agent"));
	});
});

test("e2e：真 pi 入口原生消费 ponda 环境（无 PI_CODING_AGENT_DIR）—— --list-models 列出环境内模型", () => {
	const home = newPondaHome("web-dev");
	// 环境内 models.json（经 ponda provider add 渲染的格式）
	writeFileSync(
		join(home, "envs", "web-dev", "models.json"),
		JSON.stringify({
			providers: {
				glh: {
					baseUrl: "https://api.test/v1",
					api: "openai-completions",
					apiKey: "$GLM_KEY",
					models: [{ id: "glm-p1-e2e" }],
				},
			},
		}),
	);
	const out = execFileSync(process.execPath, [PI_BIN, "--list-models", "glm-p1-e2e"], {
		env: {
			...process.env,
			PONDA_HOME: home,
			PI_CODING_AGENT_DIR: "",
			PI_CODING_AGENT_SESSION_DIR: "",
			GLM_KEY: "test-key",
		},
		encoding: "utf8",
	}).toString();
	assert.ok(out.includes("glm-p1-e2e"), `pi 原生读取 ponda 环境的 models.json：${out.slice(0, 200)}`);
});
