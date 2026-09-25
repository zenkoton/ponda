/** 权限申请协议（design: 03 §7.2）——经 protocol 包事件总线发给 TUI/CLI 应答 */

export type Privilege = "read" | "write" | "execute";
export type PermissionDecisionScope = "once" | "session" | "env-always";

export interface PermissionRequest {
	id: string;
	sessionId: string;
	privilege: Privilege;
	/** sandbox-guard 生成的说明（呈现给用户） */
	reason: string;
	detail: {
		tool: string;
		targetPath?: string;
		command?: string;
		/** C=临时工作区 B=worktree/危险命令 */
		mode: "C" | "B" | "danger";
	};
	/** 默认应答超时（ms），超时视为拒绝 */
	timeoutMs: number;
}

export interface PermissionResponse {
	requestId: string;
	approved: boolean;
	scope: PermissionDecisionScope;
	answeredAt: string;
}
