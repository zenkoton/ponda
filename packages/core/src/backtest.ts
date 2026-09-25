/**
 * 回测接口冻结（design: 07-data.md §7；roadmap M10"接口先行冻结"）。
 * 本模块只定义类型与口径常量——执行器列入 M11+（ponda backtest run 后置）。
 * 回测定义：非确定性重放不可复现 LLM 输出——回测 = 新采样重跑（同任务目标、
 * 同资源快照、变体策略），工具副作用经 worktree 隔离（复用 03 §5.3）。
 */

/** 冻结的指标口径（07 §7：completion_rate 等） */
export type BacktestMetricId =
	| "completion_rate"
	| "verification_pass_rate"
	| "avg_steps"
	| "avg_cost_usd"
	| "rollback_rate"
	| "human_intervention_rate";

export interface BacktestResourceChange {
	kind: string;
	name: string;
	action: "add" | "rm" | "update";
	version?: string;
}

export interface BacktestSpec {
	/** 任务来源：goal 任务 id / 会话 id / 数据集查询 */
	source: { taskId?: string; sessionId?: string; datasetQuery?: string };
	/** 相对基线策略的差量（变体 = envSnapshotRef + 资源变更清单） */
	variant: {
		envSnapshotRef: string; // manifest + 启用资源版本清单的哈希引用（ponda env export 产物）
		changes: BacktestResourceChange[];
	};
	budget: { maxCostUsd: number; maxSteps: number };
	/** 工具副作用隔离级别；container 级为远期（00 §9 Q6） */
	isolation: "worktree" | "container(reserved)";
	metrics: BacktestMetricId[];
}

export interface BacktestRunResult {
	variant: string;
	metrics: Partial<Record<BacktestMetricId, number>>;
	samples: number;
	costUsd: number;
}

export interface BacktestReport {
	runs: BacktestRunResult[];
	baselineRef: string;
	significance: "none" | string; // paired-test 结果摘要（执行器后置，冻结形状）
}

/** 口径的人类可读定义（文档与报告共用，防口径漂移） */
export const BACKTEST_METRIC_DEFINITIONS: Record<BacktestMetricId, string> = {
	completion_rate: "成果 verified 率（deliverables verified/total）",
	verification_pass_rate: "校准脚本通过率（收尾比对全绿比例）",
	avg_steps: "平均步数（state_patch 轮次）",
	avg_cost_usd: "平均成本（USD）",
	rollback_rate: "沙箱 discard / 回滚比率",
	human_intervention_rate: '重放中"若有人类会否被询问"的比率（权限自动按策略应答并记录）',
};
