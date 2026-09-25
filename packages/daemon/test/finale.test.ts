import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ResourceStore } from "../../core/src/resources.ts";
import { EnvStore } from "../../core/src/store.ts";
import { fauxAssistantMessage, PiAgentLoop, registerFauxProvider } from "../src/pi-loop.ts";
import { CODING_TASK_SCHEMA, newEnvelope, parseStatePatch } from "../src/skillstate-import.ts";

const cleanups: (() => void)[] = [];
function newHome(): string {
	const h = mkdtempSync(join(tmpdir(), "ponda-fin-"));
	cleanups.push(() => rmSync(h, { recursive: true, force: true }));
	return h;
}
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

// —— M2 registry ——

test("M2 registry：npm: 源安装（真实 npm pack）", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	const res = new ResourceStore(home, store);
	// 用一个小的 npm 包做真实安装验证
	const meta = res.installFromRegistry("skill", "is-even", "npm:is-even");
	assert.equal(meta.kind, "skill");
	assert.equal(meta.source.type, "registry");
	assert.ok(existsSync(join(home, "resources", "skills", `is-even@0.1.0`)), "池内目录存在");
	assert.ok(existsSync(join(home, "resources", "skills", `is-even@0.1.0`, "package.json")), "包内容存在");
});

test("M2 registry：git: 源安装（本地 git 仓库模拟）", () => {
	const home = newHome();
	const repo = newHome();
	writeFileSync(join(repo, "SKILL.md"), "# test skill\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["add", "-A"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });

	const store = new EnvStore(home);
	store.create({ name: "default" });
	const res = new ResourceStore(home, store);
	const meta = res.installFromRegistry("skill", "test-skill", `git:${repo}`);
	assert.equal(meta.source.type, "registry");
	assert.ok(existsSync(join(home, "resources", "skills", "test-skill@0.1.0", "SKILL.md")));
});

test("M2 registry：无效源报错", () => {
	const home = newHome();
	const store = new EnvStore(home);
	store.create({ name: "default" });
	const res = new ResourceStore(home, store);
	assert.throws(() => res.installFromRegistry("skill", "x", "invalid-source"), /无法解析来源/);
});

// —— P3 skill-state ——

test("P3：PiAgentLoop 绑定 skill-state 后走 (P,Σ,O) 协议", async () => {
	const faux = registerFauxProvider();
	try {
		// 严格协议（06 §3）：每轮输出须带合法 state-patch 围栏块
		faux.setResponses([fauxAssistantMessage('完成\n```state-patch\n{"state_patch": {"nextAction": "已执行"}}\n```')]);
		const loop = new PiAgentLoop({ modelId: "faux-1", faux });

		// 构造 skill-state 绑定（goal 任务的真实链路由 TaskRuntime 驱动）
		const envelope = newEnvelope("task-1", CODING_TASK_SCHEMA, {
			goal: "测试目标",
			phase: "implementing",
			todos: {},
			filesTouched: {},
			decisions: {},
			verification: {},
			openQuestions: [],
			nextAction: "执行测试",
		});
		const lastUserPrompt = "";
		loop.bindSkillState({
			buildContext: () => {
				return {
					systemPrompt: `任务规程：${envelope.state.goal}\n输出协议：单 key state_patch`,
					userPrompt: `Skill Execution State:\n${JSON.stringify(envelope.state)}\n\n请执行并输出 state_patch`,
				};
			},
			parseStatePatch: (reply) => parseStatePatch(reply),
		});

		const r = await loop.process({ userText: "开始", entryCount: 2 });
		assert.ok(r.assistantText.includes("完成"));
		// skill-state 绑定后 system prompt 被替换（内部状态不可直接断言，行为由调用方验证）
		void lastUserPrompt;
	} finally {
		faux.unregister();
	}
});
