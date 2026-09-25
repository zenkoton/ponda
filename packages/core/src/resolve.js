/**
 * 继承链解析：defaults 层 → 根环境 → ... → 目标环境（design: 01-environment.md §3）。
 * 物化（materialize）把合并后的差量补全为 EnvManifest 完整形态。
 */
import { mergeEnv } from "./merge.js";
import { SCHEMA_VERSION } from "./types.js";
/** 内置默认层（= ponda init 创建的 default 环境内容，design: 01 §2.3） */
export const DEFAULTS_INPUT = {
    identity: {
        systemPrompt: "You are a helpful coding agent.",
    },
    tools: {
        builtin: ["read", "bash", "edit", "write"],
        custom: [],
    },
    skills: [],
    extensions: [],
    themes: [],
    mcp: {},
    models: { policy: "inherit-global" },
    privileges: {
        privileges: ["read", "write", "execute"],
        sandbox: { mode: "inplace", autoGitInit: true, outsideWorkspace: "temp-workspace" },
    },
    runtime: {
        backgroundLiveness: true,
        contextStrategy: "pi-compaction",
        maxParallelSubagents: 3,
        permissionMode: "approve",
    },
};
export class EnvNotFoundError extends Error {
    constructor(name) {
        super(`environment not found: ${name}`);
        this.name = "EnvNotFoundError";
    }
}
export class EnvCycleError extends Error {
    constructor(chain) {
        super(`inheritance cycle detected: ${chain.join(" -> ")}`);
        this.name = "EnvCycleError";
    }
}
/**
 * 解析环境的生效配置。
 * - base 缺省为 "default"；"default" 环境不存在时以内置 DEFAULTS_INPUT 收尾
 * - 环境链检测成环抛 EnvCycleError；中间环境缺失抛 EnvNotFoundError
 */
export function resolveEnv(read, name) {
    const chain = [];
    const inputs = [];
    const seen = new Set();
    let current = name;
    while (current !== undefined) {
        if (seen.has(current)) {
            throw new EnvCycleError([...chain, current]);
        }
        seen.add(current);
        const manifest = read(current);
        if (manifest === null) {
            if (current === "default")
                break; // 回落到内置 defaults 层
            throw new EnvNotFoundError(current);
        }
        chain.push(current);
        inputs.push(manifest);
        const base = manifest.base ?? (current === "default" ? undefined : "default");
        current = base;
    }
    let input = DEFAULTS_INPUT;
    // chain/inputs 均为目标在前、根在后；自根向目标折叠合并
    for (let i = chain.length - 1; i >= 0; i--) {
        input = mergeEnv(input, inputs[i]);
    }
    const own = inputs[0];
    const effective = materialize(input, {
        name,
        base: own?.base,
        createdAt: own?.createdAt ?? new Date().toISOString(),
        updatedAt: own?.updatedAt ?? new Date().toISOString(),
    });
    return { chain, input, effective };
}
/** 物化：差量 → 完整 EnvManifest（幂等，不修改输入） */
export function materialize(input, meta) {
    const m = {
        schemaVersion: SCHEMA_VERSION,
        name: meta.name,
        base: meta.base,
        description: input.description,
        identity: {
            systemPrompt: input.identity?.systemPrompt ?? DEFAULTS_INPUT.identity.systemPrompt,
            appendSystemPrompt: input.identity?.appendSystemPrompt,
            memory: input.identity?.memory,
        },
        tools: {
            builtin: input.tools?.builtin ?? DEFAULTS_INPUT.tools.builtin,
            custom: (input.tools?.custom ?? []).filter((c) => !("delete" in c)),
        },
        skills: input.skills ?? [],
        extensions: input.extensions ?? [],
        themes: input.themes ?? [],
        activeTheme: input.activeTheme,
        mcp: Object.fromEntries(Object.entries(input.mcp ?? {}).filter(([, v]) => v !== null)),
        models: input.models ?? { policy: "inherit-global" },
        privileges: {
            privileges: input.privileges?.privileges ??
                DEFAULTS_INPUT.privileges.privileges,
            sandbox: {
                mode: input.privileges?.sandbox?.mode ?? "inplace",
                autoGitInit: input.privileges?.sandbox?.autoGitInit ?? true,
                outsideWorkspace: input.privileges?.sandbox?.outsideWorkspace ?? "temp-workspace",
            },
        },
        runtime: {
            backgroundLiveness: input.runtime?.backgroundLiveness ?? true,
            contextStrategy: input.runtime?.contextStrategy ?? "pi-compaction",
            skillStateDomain: input.runtime?.skillStateDomain,
            maxParallelSubagents: input.runtime?.maxParallelSubagents ?? 3,
            permissionMode: input.runtime?.permissionMode ?? "approve",
        },
        keybindings: input.keybindings
            ? Object.fromEntries(Object.entries(input.keybindings).filter(([, v]) => v !== null))
            : undefined,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
    };
    // 清理 undefined 字段的 JSON 表达
    return JSON.parse(JSON.stringify(m));
}
//# sourceMappingURL=resolve.js.map