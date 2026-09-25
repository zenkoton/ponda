import { exclusionTarget, isExclusionSelector, selectorName } from "./validate.js";
function clone(v) {
    return structuredClone(v);
}
function stripUndefined(o) {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/**
 * 选择器列表并集合并（skills/extensions/themes）：
 * - 子环境 "!name" 排除父环境同名项
 * - 子环境非排除项覆盖父环境同名项（保持父列表位置），新项追加到尾部
 */
export function mergeSelectors(base, child) {
    const exclusions = new Set(child.filter(isExclusionSelector).map(exclusionTarget));
    const childAdds = child.filter((s) => !isExclusionSelector(s));
    const childByName = new Map();
    for (const s of childAdds)
        childByName.set(selectorName(s), s);
    const result = [];
    const seen = new Set();
    for (const b of base) {
        const n = selectorName(b);
        if (exclusions.has(n) || seen.has(n))
            continue;
        seen.add(n);
        result.push(childByName.get(n) ?? b);
    }
    for (const s of childAdds) {
        const n = selectorName(s);
        if (seen.has(n))
            continue;
        seen.add(n);
        result.push(s);
    }
    return result;
}
/**
 * CommandTool 列表按 name 合并：子覆盖父（原位）、新项追加；
 * ToolDeletion（{name, delete:true}）删除父环境同名项。
 */
export function mergeCommandTools(base, child) {
    const deletions = new Set();
    const childByName = new Map();
    for (const c of child) {
        if ("delete" in c)
            deletions.add(c.name);
        else
            childByName.set(c.name, c);
    }
    const result = [];
    const seen = new Set();
    for (const b of base) {
        if ("delete" in b)
            continue; // 防御：base 中的删除条目不进入结果
        if (seen.has(b.name) || deletions.has(b.name))
            continue;
        seen.add(b.name);
        result.push(childByName.get(b.name) ?? b);
    }
    for (const c of child) {
        if ("delete" in c || seen.has(c.name))
            continue;
        seen.add(c.name);
        result.push(c);
    }
    return result;
}
/** 可空记录合并：child 值 null 删除键，否则覆盖 */
export function mergeNullableRecord(base, child) {
    const out = { ...base };
    for (const [k, v] of Object.entries(child)) {
        if (v === null)
            delete out[k];
        else
            out[k] = v;
    }
    return out;
}
/** MemoryPolicy 等宽松对象：浅合并（child 键覆盖，null 删除） */
export function mergeMemory(base, child) {
    if (child === undefined)
        return base;
    if (base === undefined)
        return child;
    const out = { ...base };
    for (const [k, v] of Object.entries(child)) {
        if (v === null)
            delete out[k];
        else
            out[k] = v;
    }
    return out;
}
function joinAppend(base, child) {
    if (child === undefined)
        return base;
    if (base === undefined || base.length === 0)
        return child;
    return `${base}\n\n${child}`;
}
/** privileges.privileges：集合并集（保持 base 顺序，新项追加） */
export function unionPrivileges(base, child) {
    const out = [...base];
    for (const p of child) {
        if (!out.includes(p))
            out.push(p);
    }
    return out;
}
/**
 * 主合并入口：base（父环境 effective 差量）⊕ child（本环境 manifest 差量）。
 * name/base/createdAt/updatedAt 不参与合并（子环境自身的值生效）。
 */
export function mergeEnv(base, child) {
    if (base === undefined)
        return clone(child);
    const out = clone(base);
    if (child.description !== undefined)
        out.description = child.description;
    if (child.activeTheme !== undefined)
        out.activeTheme = child.activeTheme;
    // name / base / createdAt / updatedAt：子环境自身值，不合并
    if (child.identity !== undefined) {
        out.identity = { ...(out.identity ?? {}) };
        if (child.identity.systemPrompt !== undefined)
            out.identity.systemPrompt = child.identity.systemPrompt;
        if (child.identity.appendSystemPrompt !== undefined) {
            out.identity.appendSystemPrompt = joinAppend(base.identity?.appendSystemPrompt, child.identity.appendSystemPrompt);
        }
        if (child.identity.memory !== undefined) {
            out.identity.memory = mergeMemory(base.identity?.memory, child.identity.memory);
        }
    }
    if (child.tools !== undefined) {
        out.tools = { ...(out.tools ?? {}) };
        if (child.tools.builtin !== undefined)
            out.tools.builtin = [...child.tools.builtin];
        if (child.tools.custom !== undefined) {
            out.tools.custom = mergeCommandTools(base.tools?.custom ?? [], child.tools.custom);
        }
    }
    for (const kind of ["skills", "extensions", "themes"]) {
        const childList = child[kind];
        if (childList !== undefined) {
            out[kind] = mergeSelectors(base[kind] ?? [], childList);
        }
    }
    if (child.mcp !== undefined) {
        out.mcp = mergeNullableRecord(base.mcp ?? {}, child.mcp);
    }
    if (child.models !== undefined) {
        const baseModels = base.models;
        out.models = { ...(baseModels ?? { policy: "inherit-global" }) };
        if (child.models.policy !== undefined)
            out.models.policy = child.models.policy;
        if (child.models.providers !== undefined && baseModels?.providers !== undefined) {
            out.models.providers = mergeNullableRecord(baseModels.providers, child.models.providers);
        }
        else if (child.models.providers !== undefined) {
            out.models.providers = child.models.providers;
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
            });
        }
    }
    if (child.runtime !== undefined) {
        out.runtime = stripUndefined({ ...(out.runtime ?? {}), ...child.runtime });
    }
    if (child.keybindings !== undefined) {
        const baseNonNull = Object.fromEntries(Object.entries(base.keybindings ?? {}).filter(([, v]) => v !== null));
        out.keybindings = mergeNullableRecord(baseNonNull, child.keybindings);
    }
    return out;
}
//# sourceMappingURL=merge.js.map