/**
 * 环境继承合并引擎 —— 逐字段策略表（design: 01-environment.md §3.1）。
 *
 * effective(env) = merge(effective(base(env)), env.manifest)
 * 深合并统一定义：对象递归；数组按字段既定策略；null = 删除目标键。
 */
import type {
	CommandTool,
	CustomToolSpec,
	EnvManifestInput,
	McpServerConfig,
	MemoryPolicy,
	Privilege,
	ResourceSelector,
} from "./types.ts";
import { exclusionTarget, isExclusionSelector, selectorName } from "./validate.ts";

function clone<T>(v: T): T {
	return structuredClone(v);
}

function stripUndefined<T extends object>(o: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(o)) {
		if (v !== undefined) out[k] = v;
	}
	return out as T;
}

/**
 * 选择器列表并集合并（skills/extensions/themes）：
 * - 子环境 "!name" 排除父环境同名项
 * - 子环境非排除项覆盖父环境同名项（保持父列表位置），新项追加到尾部
 */
export function mergeSelectors(base: ResourceSelector[], child: ResourceSelector[]): ResourceSelector[] {
	const exclusions = new Set(child.filter(isExclusionSelector).map(exclusionTarget));
	const childAdds = child.filter((s) => !isExclusionSelector(s));
	const childByName = new Map<string, ResourceSelector>();
	for (const s of childAdds) childByName.set(selectorName(s), s);

	const result: ResourceSelector[] = [];
	const seen = new Set<string>();
	for (const b of base) {
		const n = selectorName(b);
		if (exclusions.has(n) || seen.has(n)) continue;
		seen.add(n);
		result.push(childByName.get(n) ?? b);
	}
	for (const s of childAdds) {
		const n = selectorName(s);
		if (seen.has(n)) continue;
		seen.add(n);
		result.push(s);
	}
	return result;
}

/**
 * CommandTool 列表按 name 合并：子覆盖父（原位）、新项追加；
 * ToolDeletion（{name, delete:true}）删除父环境同名项。
 */
export function mergeCommandTools(base: CustomToolSpec[], child: CustomToolSpec[]): CommandTool[] {
	const deletions = new Set<string>();
	const childByName = new Map<string, CommandTool>();
	for (const c of child) {
		if ("delete" in c) deletions.add(c.name);
		else childByName.set(c.name, c);
	}

	const result: CommandTool[] = [];
	const seen = new Set<string>();
	for (const b of base) {
		if ("delete" in b) continue; // 防御：base 中的删除条目不进入结果
		if (seen.has(b.name) || deletions.has(b.name)) continue;
		seen.add(b.name);
		result.push(childByName.get(b.name) ?? b);
	}
	for (const c of child) {
		if ("delete" in c || seen.has(c.name)) continue;
		seen.add(c.name);
		result.push(c as CommandTool);
	}
	return result;
}

/** 可空记录合并：child 值 null 删除键，否则覆盖 */
export function mergeNullableRecord<T>(base: Record<string, T>, child: Record<string, T | null>): Record<string, T> {
	const out = { ...base };
	for (const [k, v] of Object.entries(child)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out;
}

/** MemoryPolicy 等宽松对象：浅合并（child 键覆盖，null 删除） */
export function mergeMemory(base?: MemoryPolicy, child?: MemoryPolicy): MemoryPolicy | undefined {
	if (child === undefined) return base;
	if (base === undefined) return child;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(child)) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out as MemoryPolicy;
}

function joinAppend(base?: string, child?: string): string | undefined {
	if (child === undefined) return base;
	if (base === undefined || base.length === 0) return child;
	return `${base}\n\n${child}`;
}

/** privileges.privileges：集合并集（保持 base 顺序，新项追加） */
export function unionPrivileges(base: Privilege[], child: Privilege[]): Privilege[] {
	const out = [...base];
	for (const p of child) {
		if (!out.includes(p)) out.push(p);
	}
	return out;
}

/**
 * 主合并入口：base（父环境 effective 差量）⊕ child（本环境 manifest 差量）。
 * name/base/createdAt/updatedAt 不参与合并（子环境自身的值生效）。
 */
export function mergeEnv(base: EnvManifestInput | undefined, child: EnvManifestInput): EnvManifestInput {
	if (base === undefined) return clone(child);
	const out: EnvManifestInput = clone(base);

	if (child.description !== undefined) out.description = child.description;
	if (child.activeTheme !== undefined) out.activeTheme = child.activeTheme;
	// name / base / createdAt / updatedAt：子环境自身值，不合并

	if (child.identity !== undefined) {
		out.identity = { ...(out.identity ?? {}) };
		if (child.identity.systemPrompt !== undefined) out.identity.systemPrompt = child.identity.systemPrompt;
		if (child.identity.appendSystemPrompt !== undefined) {
			out.identity.appendSystemPrompt = joinAppend(
				base.identity?.appendSystemPrompt,
				child.identity.appendSystemPrompt,
			);
		}
		if (child.identity.memory !== undefined) {
			out.identity.memory = mergeMemory(base.identity?.memory, child.identity.memory);
		}
	}

	if (child.tools !== undefined) {
		out.tools = { ...(out.tools ?? {}) };
		if (child.tools.builtin !== undefined) out.tools.builtin = [...child.tools.builtin];
		if (child.tools.custom !== undefined) {
			out.tools.custom = mergeCommandTools(base.tools?.custom ?? [], child.tools.custom);
		}
	}

	for (const kind of ["skills", "extensions", "themes"] as const) {
		const childList = child[kind];
		if (childList !== undefined) {
			out[kind] = mergeSelectors(base[kind] ?? [], childList);
		}
	}

	if (child.mcp !== undefined) {
		out.mcp = mergeNullableRecord<McpServerConfig | null>(base.mcp ?? {}, child.mcp);
	}

	if (child.models !== undefined) {
		const baseModels = base.models;
		out.models = { ...(baseModels ?? { policy: "inherit-global" }) };
		if (child.models.policy !== undefined) out.models.policy = child.models.policy;
		if (child.models.providers !== undefined && baseModels?.providers !== undefined) {
			out.models.providers = mergeNullableRecord(baseModels.providers, child.models.providers);
		} else if (child.models.providers !== undefined) {
			out.models.providers = child.models.providers as Record<string, import("./types.ts").ProviderDef | null>;
		}
	}

	if (child.privileges !== undefined) {
		out.privileges = { ...(out.privileges ?? {}) };
		if (child.privileges.privileges !== undefined) {
			out.privileges.privileges = unionPrivileges(base.privileges?.privileges ?? [], child.privileges.privileges);
		}
		if (child.privileges.sandbox !== undefined) {
			out.privileges.sandbox = stripUndefined({
				...(out.privileges.sandbox ?? {}),
				...child.privileges.sandbox,
			}) as import("./types.ts").SandboxPolicy;
		}
	}

	if (child.runtime !== undefined) {
		out.runtime = stripUndefined({ ...(out.runtime ?? {}), ...child.runtime });
	}

	if (child.keybindings !== undefined) {
		const baseNonNull = Object.fromEntries(
			Object.entries(base.keybindings ?? {}).filter(([, v]) => v !== null),
		) as Record<string, string>;
		out.keybindings = mergeNullableRecord<string>(baseNonNull, child.keybindings);
	}

	return out;
}
