/**
 * 弹窗（design: 04-tui.md §6；M5 第二批）：
 * - 权限申请（03 §7.2）：y 允许一次 / s 本会话 / a 总是 / n 拒绝
 * - 合并/结算确认（03 §6.3）：Enter apply / d discard / Esc 取消
 * 以居中盒覆盖在帧上（经 TuiMainScreen 差分渲染输出）。
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

const BOX_W = 64;
const BOX_H = 12;

/** 把弹窗行合成进帧（居中覆盖；不改变帧尺寸） */
export function compositeDialog(frame: string[], dialog: DialogState): string[] {
	if (dialog === null) return frame;
	const box = renderDialogBox(dialog, BOX_W);
	const out = [...frame];
	const top = Math.max(0, Math.floor((frame.length - box.length) / 2));
	for (let i = 0; i < box.length && top + i < out.length; i++) {
		const row = top + i;
		if (row === 0) continue; // 保留标题行
		const line = out[row] ?? "";
		const left = Math.max(0, Math.floor(((visibleLen(line) || line.length) - BOX_W) / 2));
		out[row] = spliceVisible(line, left, box[i] ?? "");
	}
	return out;
}

const ANSI_ONLY = /\x1b\[[0-9;]*m/g;

/** 可见宽度（CJK 记 2；弹窗自身不注入颜色，这里兼顾被合入行的 ANSI） */
function wlen(s: string): number {
	const clean = s.replace(ANSI_ONLY, "");
	let w = 0;
	for (const ch of clean) {
		w += ch.codePointAt(0) !== undefined && ch.codePointAt(0)! >= 0x1100 && !/[─┌┐└┘│]/.test(ch) ? 2 : 1;
	}
	return w;
}

/** 按可见宽度填充/截断到目标列宽 */
function fitVisible(s: string, width: number): string {
	if (wlen(s) >= width) {
		let out = "";
		for (const ch of s) {
			if (wlen(out + ch) > width) break;
			out += ch;
		}
		return out;
	}
	return s + " ".repeat(width - wlen(s));
}

function renderDialogBox(
	dialog: PermissionDialogState | MergeConfirmState | ContractConfirmState | ChangeApprovalState,
	width: number,
): string[] {
	const inner = width - 4;
	const wrap = (s: string): string[] => (wlen(s) <= inner ? [s] : [fitVisible(s, inner), s.slice([...s].length)]);
	const body: string[] =
		dialog.kind === "permission"
			? [
					`权限申请：${dialog.privilege}`,
					"",
					...wrap(dialog.reason).slice(0, 1),
					dialog.detail.targetPath !== undefined ? `目标：${dialog.detail.targetPath}` : "",
					dialog.detail.command !== undefined ? `命令：${dialog.detail.command}` : "",
					"",
					"[y] 允许一次   [s] 本会话允许",
					"[a] 总是允许   [n] 拒绝",
				]
			: dialog.kind === "merge"
				? [
						"合并 / 结算确认（sandbox）",
						"",
						...dialog.files.slice(0, 5).map((f) => `${f.status}  ${f.path}`),
						dialog.files.length > 5 ? `… 共 ${dialog.files.length} 个文件` : "",
						"",
						dialog.note,
						"",
						"[Enter] apply   [d] discard   [Esc] 取消",
					]
				: dialog.kind === "contract"
					? [
							`成果契约确认（replans: ${dialog.replans}）`,
							`目标：${dialog.goal}`.slice(0, 56),
							"",
							...dialog.deliverables
								.slice(0, 5)
								.map((d) => `${d.id} ${d.name} [${d.verifyType}] ${d.doneCriteria}`.slice(0, 56)),
							dialog.deliverables.length > 5 ? `… 共 ${dialog.deliverables.length} 项` : "",
							"",
							"[Enter] 确认冻结   [r] 打回重规划",
							"[Esc] 稍后决定",
						]
					: [
							"契约变更审批",
							`当前修订：v${dialog.contractRevision}`,
							"",
							...dialog.changes
								.slice(0, 5)
								.map((c) =>
									`${c.op} ${c.id} ${c.name}${c.reason !== undefined ? `（${c.reason}）` : ""}`.slice(0, 56),
								),
							"",
							"[y] 批准（修订+1）   [n] 拒绝",
						];
	const lines = body.filter((l) => l !== undefined);
	const box: string[] = [];
	box.push(`┌${"─".repeat(width - 2)}┐`);
	for (let i = 0; i < Math.min(lines.length, BOX_H - 2); i++) {
		const l = lines[i] ?? "";
		box.push(`│ ${fitVisible(l, inner)} │`);
	}
	while (box.length < BOX_H - 1) box.push(`│ ${"".padEnd(inner)} │`);
	box.push(`└${"─".repeat(width - 2)}┘`);
	return box;
}

// —— 弹窗合成（可见宽度对齐，CJK 记 2） ——

function visibleLen(s: string): number {
	return wlen(s);
}

function spliceVisible(base: string, at: number, overlay: string): string {
	const chars = [...base];
	const charW = (ch: string): number => (ch === "\x1b" ? 0 : wlen(ch));
	let vis = 0;
	let i = 0;
	for (; i < chars.length && vis < at; i++) {
		if (chars[i] === "\x1b") {
			const m = base.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m !== null) {
				i += m[0].length - 1;
				continue;
			}
		}
		vis += charW(chars[i] as string);
	}
	const start = i;
	const overlayW = wlen(overlay);
	for (; i < chars.length; i++) {
		if (chars[i] === "\x1b") {
			const m = base.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (m !== null) {
				i += m[0].length - 1;
				continue;
			}
		}
		vis += charW(chars[i] as string);
		if (vis >= at + overlayW) break;
	}
	return base.slice(0, start) + overlay + base.slice(Math.min(base.length, i + 1));
}
