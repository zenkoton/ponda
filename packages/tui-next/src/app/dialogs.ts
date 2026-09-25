/**
 * 弹窗状态类型（design: 04-tui.md §6）：
 * - 权限申请（03 §7.2）：y 允许一次 / s 本会话 / a 总是 / n 拒绝
 * - 合并/结算确认（03 §6.3）：Enter apply / d discard / Esc 取消
 * - 成果契约确认（05 §4.1）：Enter 确认 / r 打回重规划 / Esc 稍后
 * - 契约变更审批（05 §4.3）：y 批准 / n 拒绝
 * 渲染为 modal 元素居中覆盖（components.ts 的 DialogLayer）。
 */

export interface PermissionDialogState {
	kind: "permission";
	requestId: string;
	privilege: string;
	reason: string;
	detail: { tool: string; targetPath?: string; command?: string; mode: string };
}

export interface MergeConfirmState {
	kind: "merge";
	files: { path: string; status: string }[];
	note: string;
}

/** 成果契约确认（design: 05 §4.1）：Enter 确认 / r 打回重规划 / Esc 稍后 */
export interface ContractConfirmState {
	kind: "contract";
	taskId: string;
	goal: string;
	replans: number;
	deliverables: { id: string; name: string; doneCriteria: string; verifyType: string }[];
}

/** 契约变更审批（design: 05 §4.3）：y 批准 / n 拒绝 */
export interface ChangeApprovalState {
	kind: "change";
	taskId: string;
	changes: { op: string; id: string; name: string; reason?: string }[];
	contractRevision: number;
}

export type DialogState = PermissionDialogState | MergeConfirmState | ContractConfirmState | ChangeApprovalState | null;
