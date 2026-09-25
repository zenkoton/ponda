/**
 * ponda sandbox-guard（fork 内原生挂载点，extension 形态）—— design: docs/design/03-sandbox.md
 *
 * 职责（M3 已实现核心逻辑于 packages/sandbox；本扩展把它们接入 pi 工具执行管线）：
 * - tool_call(write/edit) → routeWrite 三域路由 + 路径重写 + 工作区外文件入临时工作区
 * - tool_call(bash) → 会话容器内执行（v1.1 容器化；无容器降级本机）+ analyzeBash 高危名单
 * - turn_end → 模式 A 快照链（snapshot）
 * - session_shutdown → 未结算活动提醒
 *
 * 状态：骨架。拦截点依赖 pi extension API（on("tool_call") 等）；pi 构建后接入联调（PATCHES.md P1）。
 */
import type { PermissionRequest } from "./permission.ts";

/** pi ExtensionAPI 的最小结构类型（联调时对齐上游真实类型，避免此处硬依赖 dist） */
interface PiExtensionApi {
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	registerTool(spec: { name: string; description: string; parameters: unknown; execute: (args: unknown) => Promise<unknown> }): void;
	// 上游真实字段见 packages/coding-agent/src/core/extensions/*.ts
}

export interface SandboxGuardConfig {
	sessionId: string;
	workspaceRoot: string;
	policy: { mode: "inplace" | "worktree"; autoGitInit: boolean; outsideWorkspace: "deny" | "temp-workspace" };
	permissionMode: "plan" | "approve" | "full-auto";
}

/** 扩展默认导出工厂（pi 经 jiti 加载） */
export default function sandboxGuard(pi: PiExtensionApi, config: SandboxGuardConfig): void {
	// 接入点登记（联调里程碑 M3 收尾时启用；当前保持类型完整以便编译期检查）
	void pi;
	void config;
	void (null as unknown as PermissionRequest | null);
}
