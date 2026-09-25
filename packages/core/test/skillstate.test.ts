import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyStatePatch,
	CODING_TASK_SCHEMA,
	getByPath,
	mergeState,
	newEnvelope,
	parseStatePatch,
	setByPath,
	validateState,
} from "../src/skillstate.ts";

const INITIAL = {
	goal: "为 CLI 添加导出命令",
	phase: "implementing",
	todos: { t1: { id: "t1", text: "解析参数", status: "done" } },
	nextAction: "写测试",
	openQuestions: [],
};

test("setByPath/getByPath：点路径、null 删除、中间层补建", () => {
	const s: Record<string, unknown> = { a: { b: { c: 1 } } };
	setByPath(s, "a.b.c", 2);
	assert.equal(getByPath(s, "a.b.c"), 2);
	setByPath(s, "a.b.d", "x");
	assert.equal(getByPath(s, "a.b.d"), "x");
	setByPath(s, "a.b.c", null);
	assert.equal(getByPath(s, "a.b.c"), undefined);
	assert.equal(getByPath(s, "a.b.c"), undefined);
	// 中间层缺失
	setByPath(s, "x.y.z", 9);
	assert.equal(getByPath(s, "x.y.z"), 9);
});

test("mergeState（⊕）：论文示例语义——null 删除、数组整体替换、深合并不污染原对象", () => {
	const state = { inventory: { shelf42: ["item12"], shelf1: ["item3"] }, cmd: "init" };
	const next = mergeState(state, { "inventory.shelf42": null, cmd: "ship" }) as {
		inventory: Record<string, string[]>;
		cmd: string;
	};
	assert.ok(!("shelf42" in next.inventory));
	assert.deepEqual(next.inventory.shelf1, ["item3"]);
	assert.equal(next.cmd, "ship");
	assert.deepEqual(state.inventory.shelf42, ["item12"], "原对象不被污染（rollback 安全）");
	// 数组整体替换
	const n2 = mergeState({ tags: ["a", "b"] }, { tags: ["a", "b", "c"] });
	assert.deepEqual(n2.tags, ["a", "b", "c"]);
});

test("parseStatePatch：协议严格校验", () => {
	// 正常
	const ok = parseStatePatch('推理...\n```state-patch\n{"state_patch": {"nextAction": "test"}}\n```');
	assert.equal(ok.ok, true);
	assert.deepEqual(ok.patch, { nextAction: "test" });

	// 多 key → 拒绝
	const bad1 = parseStatePatch('```state-patch\n{"state_patch": {}, "action": "x"}\n```');
	assert.equal(bad1.ok, false);
	assert.ok(bad1.errors[0].includes("state_patch"));

	// 缺块 → 拒绝
	assert.equal(parseStatePatch("没有块的回复").ok, false);

	// 坏 JSON → 拒绝
	assert.equal(parseStatePatch("```state-patch\n{oops}\n```").ok, false);

	// 多块：取最后并告警
	const multi = parseStatePatch(
		'```state-patch\n{"state_patch": {"a": 1}}\n```\n中段\n```state-patch\n{"state_patch": {"b": 2}}\n```',
	);
	assert.equal(multi.ok, true);
	assert.deepEqual(multi.patch, { b: 2 });
	assert.ok(multi.errors.some((e) => e.includes("2 个")));
});

test("validateState：必填/枚举/未知字段（模型不可自定义结构）", () => {
	const errors = validateState(CODING_TASK_SCHEMA, {
		goal: "g",
		phase: "yolo", // 枚举外
		// nextAction 缺失
		customField: true, // 未知字段
	});
	assert.ok(errors.some((e) => e.includes("phase")));
	assert.ok(errors.some((e) => e.includes("nextAction")));
	assert.ok(errors.some((e) => e.includes("不在领域 schema")));
	assert.equal(validateState(CODING_TASK_SCHEMA, INITIAL).length, 0);
});

test("envelope 应用链：成功推进 + 失败 rollback（状态不被污染）", () => {
	const env = newEnvelope("task-1", CODING_TASK_SCHEMA, INITIAL);
	const r1 = applyStatePatch(env, CODING_TASK_SCHEMA, {
		phase: "verifying",
		"todos.t2": { id: "t2", text: "验收", status: "doing" },
		nextAction: "跑校准",
	});
	assert.equal(r1.ok, true, r1.errors.join(";"));
	assert.equal(r1.envelope.revision, 1);
	assert.equal(r1.envelope.state.phase, "verifying");
	assert.equal(getByPath(r1.envelope.state, "todos.t2.text"), "验收");

	// 非法补丁（枚举外）→ 失败，返回的 envelope 状态保持旧值（rollback 语义）
	const r2 = applyStatePatch(r1.envelope, CODING_TASK_SCHEMA, { phase: "sleeping" });
	assert.equal(r2.ok, false);
	assert.equal(r2.envelope.state.phase, "verifying", "失败补丁不污染状态");
	assert.equal(r2.envelope.revision, 1, "失败不推进 revision");
	assert.equal(r2.envelope.history.length, 2);
	assert.equal(r2.envelope.history[1].ok, false);
	// 原 envelope 未变（结构共享不可变语义由调用方保证：r1.envelope.state 仍 verifying）
	assert.equal(r1.envelope.state.phase, "verifying");
});

test("key 抖动检测信号（06 §7 失效场景 1 的量化基础）", () => {
	// 连续补丁反复增删同名字段 → 检测器输入
	const env = newEnvelope("task-2", CODING_TASK_SCHEMA, INITIAL);
	let cur = env;
	const keySets: Set<string>[] = [];
	for (let i = 0; i < 4; i++) {
		const r = applyStatePatch(cur, CODING_TASK_SCHEMA, {
			nextAction: `step ${i}`,
			...(i % 2 === 0 ? { openQuestions: [`q${i}`] } : { openQuestions: [] }),
		});
		cur = r.envelope;
		keySets.push(new Set(Object.keys(cur.state)));
	}
	// 字段集合抖动 = keySets 两两差异；本例字段名集合其实稳定（值在变），检测的是"新增结构性字段"
	assert.equal(
		keySets.every((s) => s.has("goal")),
		true,
	);
});
