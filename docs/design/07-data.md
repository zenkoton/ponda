# 07 · 数据捕捉与回测

> readme 目的："在 pi 的基础上提供数据捕捉软件，通过强化学习提升 skills 的可用性和稳定性；提供回测技术和数据分析功能，帮助用户优化环境管理策略"。按已确认范围：**数据捕捉与指标分析做详细设计**；RL 训练与回测执行器做**架构预留与接口定义**，待核心功能落地后细化。

## 1. 模块目标与分层

```
采集层   ponda-core-ext / sandbox-guard / goal / skill-state 等运行时模块的埋点钩子（fork 内原生）
   ↓（脱敏）
存储层   ~/.ponda/telemetry/events/<YYYY-MM-DD>.jsonl（追加式事实流）
   ↓（异步 ETL，daemon 空闲时）
指标层   metrics.db（SQLite）：会话/任务/技能/成本/权限 主题表
   ↓
消费层   ponda stats（人读分析） · dataset export（RL 预留） · replay 接口（回测预留）
```

设计原则：
- **本地优先**：数据只落本机；任何上传需显式 opt-in 且经脱敏导出（本版不含上传通道）。
- **会话 JSONL 是 source of truth**：telemetry 事件是**派生加速层**，`ponda stats rebuild` 可从会话文件重建指标层；事件流的价值在于覆盖会话文件之外的动作（权限决策、校准运行、环境切换）。
- **默认关闭**：`~/.ponda/ponda.json` 的 `telemetry.enabled: false` 为默认；开启时明示采集范围。

## 2. 事件模型（详设）

```ts
/** 全部事件公共信封 */
interface TelemetryEvent<T = unknown> {
  id: string;                    // ulid
  ts: string;                    // ISO 8601
  env: string;                   // 环境名
  sessionId: string | null;
  agentId: string | null;        // swarm cell 时为 subagentId，否则 null（主 agent）
  taskId: string | null;         // goal 任务
  type: TelemetryEventType;
  payload: T;
  schemaVersion: 1;
  scrubbed: { paths: boolean; envVars: boolean; secrets: boolean };  // 脱敏执行记录
}
```

事件类型与关键 payload（TypeBox 定义，落 `packages/telemetry/src/schemas/`）：

| type | payload 要点 | 采集点 |
|---|---|---|
| `session.start` / `session.end` | workspace、model、provider、permissionMode、结束原因 | daemon / ponda-core-ext |
| `message` | role、tokens{input,output}、thinkingTokens、costUsd、latencyMs | `message_end` |
| `tool.call` | tool、argsDigest（脱敏摘要）、sandboxRoute(A/B/C)、worktreeId? | `tool_call`（重写后） |
| `tool.result` | exitOk、durationMs、resultBytes、errorClass? | `tool_result` |
| `skill.invoke` | skillName、version、触发方式(auto/命令)、后续 5 轮内成败回填 | skill 懒加载钩子 |
| `state.patch` | taskId、revision、ok、retryCount、keyChurn（06 §7 检测信号）、degraded? | skill-state |
| `task.lifecycle` | phase 迁移（05 §3.2 状态机）、todo 完成数 | goal / todolist |
| `deliverable.verify` | deliverableId、type、passed、durationMs、attempt | status-confirm |
| `permission.request` / `permission.decision` | privilege、detail摘要、decision(once/session/env-always/deny)、响应时长 | sandbox-guard + TUI/CLI |
| `sandbox.settle` | activityId、mode、files{nAdded,nModified,nDeleted}、outcome(apply/discard) | sandbox |
| `container.lifecycle` | backend（docker/podman）、image、confinement（container / audit-only 降级） | 容器后端（03 §2.1） |
| `swarm.cell` | role、status 迁移、tokens、costUsd、retries | swarm |
| `env.switch` | from、to、触发方式(手动/chpwd/配置) | CLI `env activate` |
| `resource.change` | kind、name、action(add/rm/update)、version | 资源命令 |
| `compaction` | strategy(skill-state/pi)、tokensBefore/After、degraded | skill-state / pi 钩子 |
| `error` | source(扩展名)、class、messageDigest | 全局错误处理 |

事件写入：扩展进程内经 telemetry 包的**内存队列 + 批量 fsync**（500ms 或 64 条触发），崩溃前 flush；每事件 ≤ 32KB（超长 payload 存摘要 + 指向 session JSONL 的 entry id）。

## 3. 脱敏策略（写入前同步执行）

| 类别 | 规则 |
|---|---|
| 文件路径 | 家目录→`~`；workspace 外绝对路径→`<outside>/basename`；临时工作区 id 保留 |
| 环境变量/命令 | 参数中的 `--token=*`、`API_KEY`、`Bearer *` 模式 → `<redacted>`；env 只记键名不记值 |
| 工具入参 | write/edit 的 content 只记 `{bytes, lines, hash}`；bash 命令全文保留（低敏感、高价值）但套用上一条规则 |
| 密钥形状 | 高熵字符串（≥20 位混合）启发式替换为 `<entropy>` |

`scrubbed` 字段记录实际执行的规则，`ponda stats audit` 可抽检。导出（§6/§7）在事件流脱敏之上再做一遍导出侧配置。

## 4. 存储与指标层

- **事件流**：`events/<YYYY-MM-DD>.jsonl`，按天分片；retention 默认 180 天（`telemetry.retentionDays`），`ponda stats prune` 清理。
- **metrics.db（SQLite，WAL）**，ETL 维护的物化主题：
  - `sessions`（会话粒度：时长、tokens、cost、工具调用数、结局）
  - `tasks`（goal 粒度：phase 轨迹、成果 verified 率、校准重试数）
  - `skill_stats`（**核心：可用性/稳定性**，见 §5）
  - `permission_stats`（按 privilege/tool 的批准率——衡量策略摩擦）
  - `cost_daily`（按 env/model 聚合，左栏底栏与 `cost.snapshot` 复用）
- ETL 触发：daemon 空闲（无 running 会话）或 `ponda stats rebuild [--from <date>]`；游标表记录消费位点，幂等。

## 5. 技能可用性与稳定性指标（readme 的直接诉求）

对每个 skill×version×env 维护滚动窗口（默认 30 天）：

| 指标 | 定义 |
|---|---|
| invoke_rate | 每 100 会话的调用次数（ Adoption ） |
| success_rate | 调用后 5 轮内未回滚/未道歉重试的比率（session JSONL 语义判定 + `tool.result` errorClass） |
| retry_rate | 同一 skill 短窗口（10min）内重复调用比率 |
| rollback_rate | 涉及该 skill 的沙箱 discard / git 回滚比率 |
| human_intervention_rate | 该 skill 执行中触发权限拒绝/用户插话纠正的比率 |
| cost_per_invoke | tokens 与 usd 均值 |
| verdict | 综合分（加权，权重可配）与同 env 其他 skill 的分位 |

呈现：`ponda stats skills [--env] [--sort success_rate]` 表格 + `ponda stats skills <name> --trend` 趋势（ASCII 折线）。同理提供 `ponda stats tasks / sessions / permissions / cost` 子命令。这是"帮助用户优化环境管理策略"的日常面：据此 `ponda skills rm` 表现差的 skill、调整权限策略（批准率过低 → 说明策略过严）。

## 6. RL 预留：数据集导出接口

ponda 不含训练框架，只承诺**可复现的轨迹数据集**：

```ts
interface TrajectorySample {           // 一条 = 一个任务/会话的完整轨迹
  taskId: string; envSnapshot: EnvSnapshotRef;   // manifest+资源版本的快照引用
  model: string; provider: string;
  steps: TrajectoryStep[];
  outcome: { deliverablesVerified: number; deliverablesTotal: number;
             settledAs: 'apply'|'discard'|'cancelled'; finalPhase: string };
  reward: RewardSignals;               // 见下
}
interface TrajectoryStep {
  step: number;
  observationDigest: string;           // 指向 session JSONL entry（导出可含全文，见级别）
  stateBefore?: Json; statePatch?: Json;   // skill-state 任务
  action: { tool: string; argsDigest: string };
  actionResult: { ok: boolean; durationMs: number };
  permissionDecision?: string;
}
interface RewardSignals {              // 接口定义，权重由训练侧决定
  taskComplete: boolean; verificationPassRate: number;
  costUsd: number; totalTokens: number; steps: number;
  rollbacks: number; humanInterventions: number; retries: number;
}
```

- `ponda dataset export [--env] [--task <id>] [--level digest|full] [--out dir]`：digest 级只含摘要与指针（默认，安全），full 级含观察全文（二次确认 + 全量脱敏）。
- `EnvSnapshotRef` = manifest + 启用资源版本清单的哈希引用（`ponda env export` 产物），保证轨迹可归因到确切配置——这是"通过 RL 提升 skills 可用性"的可信数据前提。
- 训练侧（策略更新后的 skill/prompt 新版本）经正常 `ponda skills add/update --version beta` 回到池中，由 §5 指标在线验证——**闭环：导出 → 外部训练 → 版本化回流 → 指标验证**。

## 7. 回测预留：replay 接口

目标：给定历史任务轨迹 + 策略变体（skill/prompt/env 配置的新版本），在受控环境重放对比。本版只定义接口与口径：

```ts
interface BacktestSpec {
  source: { taskId | sessionId | datasetQuery };
  variant: { envSnapshotRef; changes: ResourceChange[] };   // 相对基线策略的差量
  budget: { maxCostUsd: number; maxSteps: number };
  isolation: 'worktree' | 'container(reserved)';            // 00 §9 Q6
  metrics: BacktestMetricId[];                               // 口径见下
}
interface BacktestReport {
  runs: { variant: string; metrics: Record<BacktestMetricId, number>;
          samples: number; costUsd: number }[];
  baselineRef: string; significance: 'none' | 'paired-test 结果摘要';
}
```

- **口径（BacktestMetricId）**：completion_rate（成果 verified 率）、verification_pass_rate、avg_steps、avg_cost_usd、rollback_rate、human_intervention_rate（重放中权限自动按策略应答，记录"若有人类会否被询问"）。
- 执行器边界（预留）：非确定性重放不可复现 LLM 输出——回测定义为**新采样重跑**（同任务目标、同资源快照、变体策略），而非字面重放；工具副作用经 worktree 隔离（复用 03 §5.3），容器隔离为远期。
- CLI 预留形态：`ponda backtest run <spec.json> --report out.md`（M10 里程碑实现，接口先行冻结）。

## 8. 边界情况与开放问题

- **性能**：埋点全部异步，热路径（tool_call 拦截）只做内存入队，目标 <1ms 开销；批量写盘在 daemon/扩展空闲期。
- **磁盘增长**：事件流 + metrics.db 年增长估算写入文档（默认 retention 下 <2GB/重度用户）；`ponda stats du` 透视。
- **多机同步**：明确不支持（telemetry 是本机文件）；需要聚合时用 dataset export 人工汇集。
- **OQ**（00 §9 关联）：success_rate 的"未道歉重试"语义判定器需要 M10 用人工标注样本校准。
- **OQ**：权限决策数据是否足以训练策略建议模型（"environment management policy optimization"）——先积累 `permission_stats`，模型后置。
