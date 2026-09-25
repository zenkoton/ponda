/**
 * skill-state 严格协议（design: 06 §5/§6/§7）：
 * - 历史剥离：每步 prompt 只含 [system(P+工具声明), user(Σ,O)]——跨步不增长
 * - rollback-retry ≤3：无效补丁注入纠错消息重试；成功后计数清零
 * - 降级：连续超限回退完整历史模式并通知
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FauxProviderRegistration } from "../../ai/src/compat.ts";
import { createCodingTools } from "../../coding-agent/src/core/tools/index.ts";
import { fauxAssistantMessage, PiAgentLoop, registerFauxProvider, type SkillStateBinding } from "../src/pi-loop.ts";

const cleanups: (() => void)[] = [];
const fauxes: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	for (const f of fauxes.splice(0)) f.unregister();
});
function newDir(): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-ss-"));
	cleanups.push(() => rmSync(d, { recursive: true, force: true }));
	return d;
}

function bindingOf(
	state: Record<string, unknown>,
	events: { degraded?: string[]; applied?: number[] } = {},
): SkillStateBinding {
	return {
		buildContext: () => ({
			systemPrompt: "任务规程 P：按协议输出 state_patch",
			userPrompt: `Skill Execution State:\n${JSON.stringify(state)}`,
		}),
		parseStatePatch: (reply) => {
			const blocks = [...reply.matchAll(/```state-patch\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
			if (blocks.length === 0) return { errors: ["缺少 state-patch 围栏块"] };
			try {
				const raw = JSON.parse(blocks[blocks.length - 1] as string) as Record<string, unknown>;
				if (!("state_patch" in raw)) return { errors: ["必须且只能包含 state_patch 一个 key"] };
				return { patch: raw.state_patch as Record<string, unknown | null>, errors: [] };
			} catch {
				return { errors: ["JSON 解析失败"] };
			}
		},
		applyPatch: (patch) => {
			events.applied?.push(Object.keys(patch).length);
			Object.assign(state, patch);
			return { ok: true, errors: [] };
		},
		onDegraded: (reason) => {
			events.degraded?.push(reason);
		},
	};
}

const VALID = '```state-patch\n{"state_patch": {"nextAction": "继续"}}\n```';

test("历史剥离：多轮后 transcript 不随步数增长（06 §6 禁历史进 prompt）", async () => {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([
		fauxAssistantMessage(`第一步完成\n${VALID}`),
		fauxAssistantMessage(`第二步完成\n${VALID}`),
		fauxAssistantMessage(`第三步完成\n${VALID}`),
	]);
	const loop = new PiAgentLoop({ modelId: "faux-1", faux });
	const state: Record<string, unknown> = { goal: "g", nextAction: "n" };
	loop.bindSkillState(bindingOf(state));

	await loop.process({ userText: "观察1", entryCount: 2 });
	await loop.process({ userText: "观察2", entryCount: 3 });
	const after2 = loop.debugMessages().length;
	await loop.process({ userText: "观察3", entryCount: 4 });
	const after3 = loop.debugMessages().length;

	// 每轮 = [system, user, assistant] 恒定 3 条；第 3 轮不携带前两轮的 user/assistant
	assert.equal(after2, 3, "两轮后 transcript 恒定");
	assert.equal(after3, 3, "三轮后仍恒定（历史被剥离）");
	const roles = loop.debugMessages().map((m) => m.role);
	assert.deepEqual(roles, ["system", "user", "assistant"]);
	assert.ok(!JSON.stringify(loop.debugMessages()).includes("观察1"), "旧观察不进 prompt");
});

test("rollback-retry：无效补丁注入纠错消息，第二轮补正后成功（计数清零）", async () => {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([fauxAssistantMessage("无围栏块的回复"), fauxAssistantMessage(`补正\n${VALID}`)]);
	const loop = new PiAgentLoop({ modelId: "faux-1", faux });
	const state: Record<string, unknown> = { goal: "g" };
	const events: { applied: number[] } = { applied: [] };
	loop.bindSkillState(bindingOf(state, events));

	const r = await loop.process({ userText: "go", entryCount: 2 });
	assert.ok(r.assistantText.includes("补正"));
	assert.equal(events.applied.length, 1, "补丁应用一次");
	assert.equal(state.nextAction, "继续");
});

test("降级：连续 3 次重试仍无效 → 回退完整历史并通知（06 §7）", async () => {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	// 1 次初始 + 3 次重试全部无效；降级后的下一轮走完整历史（普通回复即可）
	faux.setResponses([
		fauxAssistantMessage("坏1"),
		fauxAssistantMessage("坏2"),
		fauxAssistantMessage("坏3"),
		fauxAssistantMessage("坏4"),
		fauxAssistantMessage("降级后的正常回复"),
	]);
	const loop = new PiAgentLoop({ modelId: "faux-1", faux });
	const state: Record<string, unknown> = { goal: "g" };
	const degraded: string[] = [];
	loop.bindSkillState(bindingOf(state, { degraded }));

	const r1 = await loop.process({ userText: "go", entryCount: 2 });
	assert.ok(r1.assistantText.includes("坏"), "超限后返回最后一次回复");
	assert.equal(degraded.length, 1, "降级通知一次");

	// 降级后：走完整历史路径（不再剥离/不再要求 state-patch）
	const r2 = await loop.process({ userText: "继续", entryCount: 5 });
	assert.ok(r2.assistantText.includes("降级后的正常回复"));
});

test("工具声明保留：剥离历史后 system 消息仍携带 toolsAdded（模型可见工具面）", async () => {
	const faux = registerFauxProvider();
	fauxes.push(faux);
	faux.setResponses([fauxAssistantMessage(`ok\n${VALID}`)]);
	const ws = newDir();
	const loop = new PiAgentLoop({ modelId: "faux-1", faux, tools: createCodingTools(ws) });
	const state: Record<string, unknown> = { goal: "g" };
	loop.bindSkillState(bindingOf(state));
	await loop.process({ userText: "go", entryCount: 2 });
	const sys = loop.debugMessages()[0];
	assert.ok(sys !== undefined && sys.role === "system");
	assert.ok("toolsAdded" in sys && (sys as { toolsAdded: unknown[] }).toolsAdded.length >= 4, "工具声明保留");
});
