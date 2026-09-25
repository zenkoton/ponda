/**
 * manifest 与环境名校验（design: 01-environment.md §4.1）。
 * 零依赖、手写结构校验，返回错误列表（空数组 = 通过）。
 */
import { BUILTIN_TOOLS, type EnvManifestInput, PRIVILEGES, PROVIDER_APIS, type ResourceSelector } from "./types.ts";

/** 与一级子命令冲突的保留字（design: 01 §4.1） */
export const RESERVED_WORDS: readonly string[] = [
	"env",
	"skills",
	"tools",
	"provider",
	"model",
	"prompt",
	"memory",
	"extension",
	"theme",
	"history",
	"tui",
	"goal",
	"init",
	"doctor",
	"pi",
	"hook",
	"daemon",
	"sandbox",
	"stats",
	"dataset",
	"backtest",
	"wiki",
];

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function validateEnvName(name: string): string[] {
	const errors: string[] = [];
	if (name.length === 0) {
		errors.push("环境名不能为空");
		return errors;
	}
	if (!NAME_RE.test(name)) {
		errors.push(`环境名 "${name}" 不合法：须匹配 ^[a-z][a-z0-9-]{0,63}$`);
	}
	if (RESERVED_WORDS.includes(name)) {
		errors.push(`环境名 "${name}" 是保留字（与一级子命令冲突）`);
	}
	return errors;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkSelectorList(list: unknown, field: string, errors: string[]): void {
	if (!Array.isArray(list)) {
		errors.push(`${field} 必须是数组`);
		return;
	}
	for (const item of list) {
		if (typeof item === "string") continue;
		if (isPlainObject(item)) {
			const keys = Object.keys(item);
			if (keys.includes("name") && typeof item.name === "string") {
				if (keys.includes("version") && typeof item.version === "string") continue;
				if (keys.includes("path") && typeof item.path === "string") continue;
			}
		}
		errors.push(`${field} 含非法选择器：${JSON.stringify(item)}`);
	}
}

/** 校验差量 manifest（partial 语义：缺省字段不检查）。返回错误列表。 */
export function validateManifestInput(input: EnvManifestInput): string[] {
	const errors: string[] = [];

	if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
		errors.push(`schemaVersion 须为 1，得到 ${input.schemaVersion}`);
	}
	if (input.name !== undefined) {
		errors.push(...validateEnvName(input.name));
	}
	if (input.base !== undefined && input.base !== null) {
		const base = input.base as string;
		if (typeof base !== "string" || !NAME_RE.test(base)) {
			errors.push(`base "${String(base)}" 不是合法环境名`);
		}
	}
	if (input.description !== undefined && typeof input.description !== "string") {
		errors.push("description 须为字符串");
	}

	if (input.identity !== undefined) {
		const id = input.identity;
		if (id.systemPrompt !== undefined) {
			const sp = id.systemPrompt;
			if (typeof sp !== "string" && !(isPlainObject(sp) && typeof sp.pool === "string")) {
				errors.push("identity.systemPrompt 须为字符串或 { pool: string }");
			}
		}
		if (id.appendSystemPrompt !== undefined && typeof id.appendSystemPrompt !== "string") {
			errors.push("identity.appendSystemPrompt 须为字符串");
		}
		if (id.memory !== undefined && !isPlainObject(id.memory)) {
			errors.push("identity.memory 须为对象");
		}
	}

	if (input.tools !== undefined) {
		const t = input.tools;
		if (t.builtin !== undefined) {
			if (!Array.isArray(t.builtin)) {
				errors.push("tools.builtin 须为数组");
			} else {
				for (const b of t.builtin) {
					if (!BUILTIN_TOOLS.includes(b)) {
						errors.push(`tools.builtin 含未知内置工具 "${String(b)}"（允许：${BUILTIN_TOOLS.join("|")}）`);
					}
				}
			}
		}
		if (t.custom !== undefined) {
			if (!Array.isArray(t.custom)) {
				errors.push("tools.custom 须为数组");
			} else {
				for (const c of t.custom) {
					if (isPlainObject(c) && c.delete === true) {
						if (typeof c.name !== "string" || c.name.length === 0) {
							errors.push(`tools.custom 删除条目须含 name：${JSON.stringify(c)}`);
						}
						continue;
					}
					if (!isPlainObject(c) || typeof c.name !== "string" || typeof c.command !== "string") {
						errors.push(`tools.custom 条目须含 name/command 字符串：${JSON.stringify(c)}`);
					} else if (c.description !== undefined && typeof c.description !== "string") {
						errors.push(`tools.custom[${c.name}].description 须为字符串`);
					}
				}
			}
		}
	}

	if (input.skills !== undefined) checkSelectorList(input.skills, "skills", errors);
	if (input.extensions !== undefined) checkSelectorList(input.extensions, "extensions", errors);
	if (input.themes !== undefined) checkSelectorList(input.themes, "themes", errors);

	if (input.activeTheme !== undefined && typeof input.activeTheme !== "string") {
		errors.push("activeTheme 须为字符串");
	}

	if (input.mcp !== undefined) {
		if (!isPlainObject(input.mcp)) {
			errors.push("mcp 须为对象");
		} else {
			for (const [k, v] of Object.entries(input.mcp)) {
				if (v !== null && !isPlainObject(v)) {
					errors.push(`mcp["${k}"] 须为对象或 null`);
				}
			}
		}
	}

	if (input.models !== undefined) {
		const m = input.models;
		if (m.policy !== undefined && m.policy !== "inherit-global" && m.policy !== "explicit") {
			errors.push(`models.policy 须为 "inherit-global" | "explicit"，得到 "${String(m.policy)}"`);
		}
		if (m.providers !== undefined) {
			if (!isPlainObject(m.providers)) {
				errors.push("models.providers 须为对象");
			} else {
				for (const [k, v] of Object.entries(m.providers)) {
					if (v === null) continue;
					if (!isPlainObject(v) || typeof v.baseUrl !== "string" || typeof v.api !== "string") {
						errors.push(`models.providers["${k}"] 须含 baseUrl/api`);
					} else if (!PROVIDER_APIS.includes(v.api as never)) {
						errors.push(`models.providers["${k}"].api 非法：${String(v.api)}`);
					} else if (
						!Array.isArray(v.models) ||
						v.models.some((mm) => !isPlainObject(mm) || typeof mm.id !== "string")
					) {
						errors.push(`models.providers["${k}"].models 须为 [{ id: string }]`);
					}
				}
			}
		}
	}

	if (input.privileges !== undefined) {
		const p = input.privileges;
		if (p.privileges !== undefined) {
			if (!Array.isArray(p.privileges)) {
				errors.push("privileges.privileges 须为数组");
			} else {
				for (const x of p.privileges) {
					if (!PRIVILEGES.includes(x)) {
						errors.push(`privileges.privileges 含非法值 "${String(x)}"（允许：${PRIVILEGES.join("|")}）`);
					}
				}
			}
		}
		if (p.sandbox !== undefined) {
			if (!isPlainObject(p.sandbox)) {
				errors.push("privileges.sandbox 须为对象");
			} else {
				if (p.sandbox.mode !== undefined && p.sandbox.mode !== "inplace" && p.sandbox.mode !== "worktree") {
					errors.push(`privileges.sandbox.mode 非法：${String(p.sandbox.mode)}`);
				}
				if (
					p.sandbox.outsideWorkspace !== undefined &&
					p.sandbox.outsideWorkspace !== "deny" &&
					p.sandbox.outsideWorkspace !== "temp-workspace"
				) {
					errors.push(`privileges.sandbox.outsideWorkspace 非法：${String(p.sandbox.outsideWorkspace)}`);
				}
				if (p.sandbox.autoGitInit !== undefined && typeof p.sandbox.autoGitInit !== "boolean") {
					errors.push("privileges.sandbox.autoGitInit 须为布尔值");
				}
			}
		}
	}

	if (input.runtime !== undefined) {
		const r = input.runtime;
		if (
			r.contextStrategy !== undefined &&
			r.contextStrategy !== "pi-compaction" &&
			r.contextStrategy !== "skill-state"
		) {
			errors.push(`runtime.contextStrategy 非法：${String(r.contextStrategy)}`);
		}
		if (
			r.permissionMode !== undefined &&
			r.permissionMode !== "plan" &&
			r.permissionMode !== "approve" &&
			r.permissionMode !== "full-auto"
		) {
			errors.push(`runtime.permissionMode 非法：${String(r.permissionMode)}`);
		}
		if (r.backgroundLiveness !== undefined && typeof r.backgroundLiveness !== "boolean") {
			errors.push("runtime.backgroundLiveness 须为布尔值");
		}
		if (
			r.maxParallelSubagents !== undefined &&
			(typeof r.maxParallelSubagents !== "number" ||
				!Number.isInteger(r.maxParallelSubagents) ||
				r.maxParallelSubagents < 1)
		) {
			errors.push("runtime.maxParallelSubagents 须为正整数");
		}
		if (r.skillStateDomain !== undefined && typeof r.skillStateDomain !== "string") {
			errors.push("runtime.skillStateDomain 须为字符串");
		}
	}

	if (input.keybindings !== undefined) {
		if (!isPlainObject(input.keybindings)) {
			errors.push("keybindings 须为对象");
		} else {
			for (const [k, v] of Object.entries(input.keybindings)) {
				if (typeof v !== "string" && v !== null) {
					errors.push(`keybindings["${k}"] 须为字符串或 null`);
				}
			}
		}
	}

	return errors;
}

/** 选择器的名字（含 "!" 排除前缀则原样返回） */
export function selectorName(s: ResourceSelector): string {
	if (typeof s === "string") return s;
	return s.name;
}

/** 是否为排除选择器（"!name" 形态） */
export function isExclusionSelector(s: ResourceSelector): boolean {
	return selectorName(s).startsWith("!");
}

/** 排除选择器去掉 "!" 后的目标名 */
export function exclusionTarget(s: ResourceSelector): string {
	return selectorName(s).slice(1);
}
