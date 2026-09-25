/**
 * goal 任务运行时（design: 05-runtime.md §3/§4；M6）。
 * - 生命周期状态机：created → planning → confirmed → executing → verifying → settled → closed
 *   （计划被拒 → re-planning ≤ 2 次，之后要求用户改目标；取消 = cancelled）
 * - 成果契约 DeliverableSpec：用户确认即冻结基线；变更需审批（contractRevision 递增，旧版留档）
 * - 校准代码：确认后生成 <workspace>/.ponda/verify/<taskId>/d<N>.<sh> + verify.json，
 *   试跑一次记基线；verifying 阶段逐项运行比对（重跑 ≤ 3 轮）
 * - skill-state 绑定：goal 任务强制结构化状态（06 §3），phase 迁移写入 envelope
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyStatePatch,
	CODING_TASK_SCHEMA,
	newEnvelope,
	type SkillStateEnvelope,
} from "../../core/src/skillstate.ts";
import type { DeliverableChange, DeliverableSpec, TaskInfo, TaskPhase } from "../../rpc/src/protocol.ts";
import { loadStateDir, persistState } from "./persist.ts";

export class GoalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GoalError";
	}
}

interface TaskRecord {
	info: TaskInfo;
	/** 冻结的契约版本历史（contractRevision → deliverables） */
	contractHistory: Record<number, DeliverableSpec[]>;
	envelope: SkillStateEnvelope;
	verifyRounds: number;
}

export type TaskEventSink = (taskId: string, event: { kind: string; [k: string]: unknown }) => void;

export interface StartTaskOptions {
	goal: string;
	workspace?: string | null;
	sessionId?: string | null;
	/** planning 产出的成果契约（真实链路由 agent 规划产出；此处由发起方注入） */
	deliverables?: DeliverableSpec[];
}

const VERIFY_TIMEOUT_MS = 30000;

export class TaskRuntime {
	private readonly tasks = new Map<string, TaskRecord>();
	private sink: TaskEventSink | null = null;
	/** 状态持久化目录（~/.ponda/envs/<env>/state/tasks；不传 = 纯内存，测试用） */
	private readonly stateDir: string | null;

	constructor(opts: { stateDir?: string } = {}) {
		this.stateDir = opts.stateDir ?? null;
		if (this.stateDir !== null) {
			// daemon 重启恢复（05 §5.2：恢复依托 envelope 快照，不依赖历史重放）
			const loaded = loadStateDir<TaskRecord>(this.stateDir);
			for (const [id, rec] of loaded) {
				if (rec?.info?.taskId === id) this.tasks.set(id, rec);
			}
		}
	}

	setEventSink(sink: TaskEventSink): void {
		this.sink = sink;
	}

	/** 写穿快照：TaskRecord 全量 + envelope 双写工作区 .ponda/state/（06 §3） */
	private persist(t: TaskRecord): void {
		if (this.stateDir === null) return;
		persistState(this.stateDir, t.info.taskId, t);
		if (t.info.workspace !== null) {
			persistState(join(t.info.workspace, ".ponda", "state"), t.info.taskId, t.envelope);
		}
	}

	private emit(taskId: string, kind: string, extra: Record<string, unknown> = {}): void {
		this.sink?.(taskId, { kind, ...extra });
	}

	private must(taskId: string): TaskRecord {
		const t = this.tasks.get(taskId);
		if (t === undefined) throw new GoalError(`task not found: ${taskId}`);
		return t;
	}

	list(): TaskInfo[] {
		return [...this.tasks.values()].map((t) => cloneTask(t));
	}

	get(taskId: string): TaskInfo {
		return cloneTask(this.must(taskId));
	}

	envelope(taskId: string): SkillStateEnvelope {
		return this.must(taskId).envelope;
	}

	/** 创建 goal 任务（进入 planning；产出清单交用户确认） */
	start(opts: StartTaskOptions): TaskInfo {
		const taskId = randomUUID();
		const deliverables = (opts.deliverables ?? defaultDeliverables(opts.goal)).map((d, i) => ({
			...d,
			id: d.id || `d${i + 1}`,
			status: "planned" as const,
		}));
		const envelope = newEnvelope(taskId, CODING_TASK_SCHEMA, {
			goal: opts.goal,
			phase: "planning",
			todos: {},
			filesTouched: {},
			decisions: {},
			verification: {},
			openQuestions: [],
			nextAction: "等待用户确认成果契约",
		});
		const record: TaskRecord = {
			info: {
				taskId,
				goal: opts.goal,
				phase: "planning",
				replans: 0,
				sessionId: opts.sessionId ?? null,
				workspace: opts.workspace ?? null,
				deliverables,
				contractRevision: 0,
				pendingChanges: null,
				settledAt: null,
				cancelledAt: null,
			},
			contractHistory: { 0: structuredClone(deliverables) },
			envelope,
			verifyRounds: 0,
		};
		this.tasks.set(taskId, record);
		this.persist(record);
		this.emit(taskId, "phase", { phase: "planning" });
		return cloneTask(record);
	}

	/** 用户确认成果契约：冻结基线 + 生成校准代码并试跑（design: 05 §4.1/§4.2） */
	confirm(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["planning"], "confirm");
		t.info.phase = "confirmed";
		// 校准代码生成 + 基线试跑
		if (t.info.workspace !== null) {
			const dir = join(t.info.workspace, ".ponda", "verify", taskId);
			mkdirSync(dir, { recursive: true });
			const entries: { deliverable: string; type: string; command?: string; expectExit?: number }[] = [];
			for (const d of t.info.deliverables) {
				if (d.verify.type !== "command" || d.verify.command === undefined) continue;
				const script = join(dir, `${d.id}.sh`);
				writeFileSync(script, `#!/bin/sh\n${d.verify.command}\n`, { encoding: "utf8" });
				entries.push({
					deliverable: d.id,
					type: "command",
					command: d.verify.command,
					expectExit: d.verify.expectExit ?? 0,
				});
				const result = this.runCaliber(t.info.workspace, script);
				d.lastVerify = {
					at: new Date().toISOString(),
					passed: result.passed,
					attempt: 1,
					detail: result.detail,
				};
				this.emit(taskId, "verify", {
					deliverable: d.id,
					passed: result.passed,
					attempt: 1,
					detail: result.detail,
				});
			}
			writeFileSync(join(dir, "verify.json"), `${JSON.stringify({ taskId, entries }, null, "\t")}\n`, "utf8");
		}
		t.info.phase = "executing";
		this.transition(t, "executing");
		this.persist(t);
		return cloneTask(t);
	}

	/** 计划被打回 → re-planning（≤2 次，之后要求改目标，design: 05 §3.2） */
	replan(taskId: string, deliverables?: DeliverableSpec[]): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["planning"], "replan");
		if (t.info.replans >= 2) {
			throw new GoalError("re-planning 次数已达上限（2），请修改目标后重新创建任务");
		}
		t.info.replans++;
		if (deliverables !== undefined) {
			t.info.deliverables = deliverables.map((d, i) => ({
				...d,
				id: d.id || `d${i + 1}`,
				status: "planned" as const,
			}));
			t.contractHistory[t.info.contractRevision] = structuredClone(t.info.deliverables);
		}
		this.emit(taskId, "phase", { phase: "planning", replans: t.info.replans });
		this.persist(t);
		return cloneTask(t);
	}

	/** 执行中：标记成果交付（agent 声明产出后调用） */
	deliver(taskId: string, deliverableId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["executing", "confirmed"], "deliver");
		const d = t.info.deliverables.find((x) => x.id === deliverableId);
		if (d === undefined) throw new GoalError(`deliverable not found: ${deliverableId}`);
		d.status = "delivered";
		this.emit(taskId, "deliverable", { deliverable: deliverableId, status: "delivered" });
		this.persist(t);
		return cloneTask(t);
	}

	/** 收尾比对：逐项运行校准脚本（≤3 轮重试；全绿 → settled，design: 05 §4.2） */
	verify(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["executing", "verifying"], "verify");
		if (t.info.workspace === null) throw new GoalError("任务无工作区，无法运行校准");
		if (t.verifyRounds >= 3) {
			throw new GoalError("校准重跑已达上限（3 轮），存在未通过成果");
		}
		t.verifyRounds++;
		t.info.phase = "verifying";
		this.emit(taskId, "phase", { phase: "verifying", round: t.verifyRounds });
		const dir = join(t.info.workspace, ".ponda", "verify", taskId);
		let allPassed = true;
		for (const d of t.info.deliverables) {
			if (d.status === "changed-pending") continue;
			if (d.verify.type === "manual") {
				// 人工核验项：最终报告留给用户勾选，此处记 delivered
				if (d.status === "planned") d.status = "delivered";
				continue;
			}
			const script = join(dir, `${d.id}.sh`);
			if (!existsSync(script)) throw new GoalError(`校准脚本缺失：${script}`);
			const result = this.runCaliber(t.info.workspace, script, d.verify);
			d.lastVerify = {
				at: new Date().toISOString(),
				passed: result.passed,
				attempt: t.verifyRounds,
				detail: result.detail,
			};
			this.emit(taskId, "verify", {
				deliverable: d.id,
				passed: result.passed,
				attempt: t.verifyRounds,
				detail: result.detail,
			});
			d.status = result.passed ? "verified" : "failed";
			if (!result.passed) allPassed = false;
		}
		if (allPassed) {
			t.info.phase = "settled";
			t.info.settledAt = new Date().toISOString();
			this.transition(t, "settled");
		}
		this.persist(t);
		return cloneTask(t);
	}

	/** 结算（合并确认由 sandbox 流程负责；此处仅落 settled 语义） */
	settle(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["verifying"], "settle");
		t.info.phase = "settled";
		t.info.settledAt = new Date().toISOString();
		this.transition(t, "settled");
		this.persist(t);
		return cloneTask(t);
	}

	close(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["settled"], "close");
		t.info.phase = "closed";
		this.transition(t, "closed");
		this.persist(t);
		return cloneTask(t);
	}

	cancel(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["planning", "confirmed", "executing", "verifying"], "cancel");
		t.info.phase = "cancelled";
		t.info.cancelledAt = new Date().toISOString();
		for (const d of t.info.deliverables) {
			if (d.status !== "verified") d.status = "failed";
		}
		this.transition(t, "cancelled");
		this.persist(t);
		return cloneTask(t);
	}

	/**
	 * daemon 崩溃/重启后恢复执行（design: 05 §5.2）：任务状态来自持久化快照，
	 * 恢复不依赖会话历史重放——envelope 即"未来执行的充分统计量"（06 §6）。
	 */
	resume(taskId: string): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["confirmed", "executing", "verifying"], "resume");
		this.emit(taskId, "resumed", { phase: t.info.phase });
		return cloneTask(t);
	}

	/** 契约变更申请：挂 changed-pending，等用户审批（design: 05 §4.3） */
	changeRequest(taskId: string, changes: DeliverableChange[]): TaskInfo {
		const t = this.must(taskId);
		this.expect(t, ["confirmed", "executing", "verifying"], "change_request");
		t.info.pendingChanges = changes;
		for (const c of changes) {
			if (c.op === "modify" || c.op === "remove") {
				const d = t.info.deliverables.find((x) => x.id === c.deliverable.id);
				if (d !== undefined) d.status = "changed-pending";
			}
		}
		this.emit(taskId, "change_requested", { changes });
		this.persist(t);
		return cloneTask(t);
	}

	/** 变更审批：批准 → 应用并 contractRevision+1（旧版留档）；拒绝 → 恢复原状态 */
	approveChange(taskId: string, accept: boolean): TaskInfo {
		const t = this.must(taskId);
		if (t.info.pendingChanges === null) throw new GoalError("无待审批的契约变更");
		const changes = t.info.pendingChanges;
		t.info.pendingChanges = null;
		if (accept) {
			for (const d of t.info.deliverables) {
				if (d.status === "changed-pending") d.status = "planned";
			}
			for (const c of changes) {
				if (c.op === "add") {
					t.info.deliverables.push({ ...c.deliverable, status: "planned" });
				} else if (c.op === "modify") {
					const i = t.info.deliverables.findIndex((x) => x.id === c.deliverable.id);
					if (i >= 0) t.info.deliverables[i] = { ...c.deliverable, status: "planned" };
				} else if (c.op === "remove") {
					t.info.deliverables = t.info.deliverables.filter((x) => x.id !== c.deliverable.id);
				}
			}
			t.info.contractRevision++;
			t.contractHistory[t.info.contractRevision] = structuredClone(t.info.deliverables);
			// 新增/修改的 command 型成果：补写校准脚本
			if (t.info.workspace !== null) {
				const dir = join(t.info.workspace, ".ponda", "verify", taskId);
				for (const c of changes) {
					if (c.op === "remove") continue;
					if (c.deliverable.verify.type === "command" && c.deliverable.verify.command !== undefined) {
						writeFileSync(
							join(dir, `${c.deliverable.id}.sh`),
							`#!/bin/sh\n${c.deliverable.verify.command}\n`,
							"utf8",
						);
					}
				}
			}
		} else {
			for (const d of t.info.deliverables) {
				if (d.status === "changed-pending") d.status = "planned";
			}
		}
		this.emit(taskId, "change_decided", { accepted: accept, revision: t.info.contractRevision });
		this.persist(t);
		return cloneTask(t);
	}

	// —— 内部 ——

	private expect(t: TaskRecord, phases: TaskPhase[], action: string): void {
		if (!phases.includes(t.info.phase)) {
			throw new GoalError(`phase ${t.info.phase} 不允许 ${action}（允许：${phases.join("/")}; design 05 §3.2）`);
		}
	}

	private runCaliber(
		workspace: string,
		script: string,
		verify?: DeliverableSpec["verify"],
	): { passed: boolean; detail: string } {
		const r = spawnSync("/bin/sh", [script], { cwd: workspace, encoding: "utf8", timeout: VERIFY_TIMEOUT_MS });
		const code = r.status ?? -1;
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 200);
		let passed = code === (verify?.expectExit ?? 0);
		if (passed && verify?.expectOutputContains !== undefined) {
			passed = out.includes(verify.expectOutputContains);
		}
		return { passed, detail: `exit=${code} ${out}`.trim() };
	}

	/** phase 迁移同步进 skill-state envelope（06 §3：goal 强制结构化状态） */
	private transition(t: TaskRecord, phase: TaskPhase): void {
		const map: Partial<Record<TaskPhase, string>> = {
			confirmed: "implementing",
			executing: "implementing",
			verifying: "verifying",
			settled: "done",
			closed: "done",
			cancelled: "done",
		};
		const statePhase = map[phase];
		if (statePhase === undefined) return;
		const r = applyStatePatch(t.envelope, CODING_TASK_SCHEMA, {
			phase: statePhase,
			nextAction: statePhase === "done" ? "任务已结束" : `阶段：${phase}`,
			verification: Object.fromEntries(
				t.info.deliverables.map((d) => [
					d.id,
					{ deliverable: d.id, status: d.status, detail: d.lastVerify?.detail ?? "" },
				]),
			),
		});
		if (r.ok) t.envelope = r.envelope;
		this.emit(t.info.taskId, "phase", { phase });
	}
}

// —— 局部工具 ——

function cloneTask(t: TaskRecord): TaskInfo {
	return JSON.parse(JSON.stringify(t.info)) as TaskInfo;
}

function defaultDeliverables(goal: string): DeliverableSpec[] {
	// 无注入契约时的兜底规划（真实链路由 agent planning 产出）
	void goal;
	return [
		{
			id: "d1",
			name: "任务产出",
			description: "目标达成的可观察产出（默认契约，请确认或打回）",
			doneCriteria: "产出存在且可被人工核验",
			verify: { type: "manual" },
			status: "planned",
		},
	];
}
