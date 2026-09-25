/**
 * SKILL.state 核心：⊕ 合并、state-patch 协议校验、领域 schema（design: 06-context.md）。
 * 严格按论文（arXiv:2608.26263v3）要求：
 * - 补丁只含 state_patch 单一 key，点路径，null=删除
 * - 校验/合并在确定性运行时侧执行（本模块），模型无权定义状态结构
 * - 应用后对 Σ 整体校验（防小模型"漏合并旧 key"），失败走 rollback-retry
 */
import type { JsonRecord } from "./json.ts";

/** 点路径取值：a.b.c → state.a.b.c */
export function getByPath(state: JsonRecord, path: string): unknown {
	let cur: unknown = state;
	for (const seg of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as JsonRecord)[seg];
	}
	return cur;
}

/** 点路径设值（null=删除；中间层缺失时按需创建对象） */
export function setByPath(state: JsonRecord, path: string, value: unknown): void {
	const segs = path.split(".");
	let cur = state;
	for (let i = 0; i < segs.length - 1; i++) {
		const seg = segs[i];
		const next = (cur as JsonRecord)[seg];
		if (next === null || typeof next !== "object" || Array.isArray(next)) {
			(cur as JsonRecord)[seg] = {}; // 数组/标量中间层：覆盖为对象（patch 语义）
		}
		cur = (cur as JsonRecord)[seg] as JsonRecord;
	}
	const last = segs[segs.length - 1];
	if (value === null) delete (cur as JsonRecord)[last];
	else (cur as JsonRecord)[last] = value;
}

/**
 * ⊕ 合并算子（06 §3）：逐 key 应用补丁。
 * - value === null → 删除该 key（点路径支持）
 * - 其余（含数组）→ 覆盖（数组整体替换；论文小模型失败主因是元素级"漏合并"，整体替换最稳）
 */
export function mergeState(state: JsonRecord, patch: Record<string, unknown | null>): JsonRecord {
	const next = structuredClone(state) as JsonRecord;
	for (const [path, value] of Object.entries(patch)) {
		setByPath(next, path, value);
	}
	return next;
}

// —— state-patch 协议（模型输出 → 运行时校验） ——

export interface ParsedPatch {
	ok: boolean;
	patch?: Record<string, unknown | null>;
	/** 解析/校验失败原因（注入 rollback-retry 提示） */
	errors: string[];
}

/** 从模型回复文本提取并校验 state-patch 围栏块（多个块时取最后一个并告警） */
export function parseStatePatch(replyText: string): ParsedPatch {
	const errors: string[] = [];
	const blocks = [...replyText.matchAll(/```state-patch\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
	if (blocks.length === 0) {
		return { ok: false, errors: ["缺少 ```state-patch 围栏块（协议要求每轮输出）"] };
	}
	if (blocks.length > 1) errors.push(`检测到 ${blocks.length} 个 state-patch 块，取最后一个`);
	let raw: unknown;
	try {
		raw = JSON.parse(blocks[blocks.length - 1]);
	} catch (e) {
		return { ok: false, errors: [`state-patch JSON 解析失败：${(e as Error).message}`] };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, errors: ["state-patch 须为 JSON 对象"] };
	}
	const keys = Object.keys(raw as JsonRecord);
	if (keys.length !== 1 || keys[0] !== "state_patch") {
		return { ok: false, errors: [`state-patch 必须且只能包含 state_patch 一个 key（得到：${keys.join(",")}）`] };
	}
	const patch = (raw as { state_patch: unknown }).state_patch;
	if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
		return { ok: false, errors: ["state_patch 值须为对象（key→value|null）"] };
	}
	return { ok: true, patch: patch as Record<string, unknown | null>, errors };
}

// —— 领域 schema（按领域撰写、跨任务复用；06 §4） ——

export interface FieldSpec {
	type: "string" | "number" | "boolean" | "string[]" | "record" | "object";
	required?: boolean;
	/** record/object 的子校验（浅层） */
	itemShape?: Record<string, "string" | "number" | "boolean">;
	enumValues?: string[];
	doc: string;
}

export interface DomainSchema {
	id: string; // 如 "coding-task@1"
	fields: Record<string, FieldSpec>;
}

/** 内置领域：coding-task（goal 模式默认，06 §4） */
export const CODING_TASK_SCHEMA: DomainSchema = {
	id: "coding-task@1",
	fields: {
		goal: { type: "string", required: true, doc: "任务目标（通常不变）" },
		phase: {
			type: "string",
			required: true,
			enumValues: ["planning", "implementing", "verifying", "done"],
			doc: "任务阶段",
		},
		todos: {
			type: "object",
			doc: "任务分解",
			itemShape: { id: "string", text: "string", status: "string" },
		},
		filesTouched: {
			type: "object",
			doc: "已触碰文件",
			itemShape: { path: "string", change: "string", summary: "string" },
		},
		decisions: { type: "object", doc: "关键决策", itemShape: { choice: "string", reason: "string" } },
		verification: { type: "object", doc: "成果校验状态", itemShape: { deliverable: "string", status: "string" } },
		openQuestions: { type: "string[]", doc: "待用户澄清事项" },
		nextAction: { type: "string", required: true, doc: "下一步一句话（引导每步总结）" },
	},
};

/** 整体校验 Σ（比只校验补丁更强，直接防"漏合并"） */
export function validateState(schema: DomainSchema, state: JsonRecord): string[] {
	const errors: string[] = [];
	for (const [name, spec] of Object.entries(schema.fields)) {
		const v = state[name];
		if (v === undefined || v === null) {
			if (spec.required) errors.push(`${name}：必填字段缺失`);
			continue;
		}
		const err = checkField(name, spec, v);
		errors.push(...err);
	}
	// 未知字段：拒绝（schema 归属运行时，模型不可自定义结构）
	for (const key of Object.keys(state)) {
		if (!(key in schema.fields)) errors.push(`${key}：不在领域 schema ${schema.id} 中（禁止模型自定义状态结构）`);
	}
	return errors;
}

function checkField(name: string, spec: FieldSpec, v: unknown): string[] {
	const errors: string[] = [];
	switch (spec.type) {
		case "string":
			if (typeof v !== "string") errors.push(`${name}：须为 string`);
			else if (spec.enumValues && !spec.enumValues.includes(v))
				errors.push(`${name}：非法值 "${v}"（允许 ${spec.enumValues.join("|")}）`);
			break;
		case "number":
			if (typeof v !== "number") errors.push(`${name}：须为 number`);
			break;
		case "boolean":
			if (typeof v !== "boolean") errors.push(`${name}：须为 boolean`);
			break;
		case "string[]":
			if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) errors.push(`${name}：须为 string[]`);
			break;
		case "record":
		case "object": {
			if (typeof v !== "object" || v === null || Array.isArray(v)) {
				errors.push(`${name}：须为对象`);
				break;
			}
			if (spec.itemShape) {
				for (const [itemKey, itemVal] of Object.entries(v as JsonRecord)) {
					const shape = spec.itemShape[itemKey];
					if (shape && typeof itemVal !== shape) {
						errors.push(`${name}.${itemKey}：须为 ${shape}`);
					}
				}
			}
			break;
		}
	}
	return errors;
}

// —— envelope（任务级持久化信封） ——

export interface SkillStateEnvelope {
	taskId: string;
	domain: string;
	schemaId: string;
	state: JsonRecord;
	revision: number;
	updatedAt: string;
	/** 审计/回放（不进 prompt；保留上限可配） */
	history: { revision: number; patch: Record<string, unknown | null>; at: string; ok: boolean }[];
}

export function newEnvelope(taskId: string, schema: DomainSchema, initial: JsonRecord): SkillStateEnvelope {
	const errors = validateState(schema, initial);
	if (errors.length > 0) throw new Error(`initial state invalid: ${errors.join("; ")}`);
	return {
		taskId,
		domain: schema.id.split("@")[0],
		schemaId: schema.id,
		state: structuredClone(initial),
		revision: 0,
		updatedAt: new Date().toISOString(),
		history: [],
	};
}

export interface ApplyResult {
	ok: boolean;
	envelope: SkillStateEnvelope; // 失败时返回原 envelope（rollback 语义：状态不被污染）
	errors: string[];
}

/** 应用一次补丁：解析由调用方完成（parseStatePatch）；此处校验→⊕→整体校验→落 envelope */
export function applyStatePatch(
	env: SkillStateEnvelope,
	schema: DomainSchema,
	patch: Record<string, unknown | null>,
	opts: { historyLimit?: number } = {},
): ApplyResult {
	const limit = opts.historyLimit ?? 100;
	const candidate = mergeState(env.state, patch);
	const errors = validateState(schema, candidate);
	if (errors.length > 0) {
		return {
			ok: false,
			envelope: {
				...env,
				history: [
					...env.history,
					{ revision: env.revision + 1, patch, at: new Date().toISOString(), ok: false },
				].slice(-limit),
			},
			errors,
		};
	}
	const next: SkillStateEnvelope = {
		...env,
		state: candidate,
		revision: env.revision + 1,
		updatedAt: new Date().toISOString(),
		history: [...env.history, { revision: env.revision + 1, patch, at: new Date().toISOString(), ok: true }].slice(
			-limit,
		),
	};
	return { ok: true, envelope: next, errors: [] };
}
