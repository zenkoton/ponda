# 06 · 上下文管理：SKILL.state 适配

> readme："长时任务使用 skill.state 模式进行上下文管理"（参照 arXiv:2608.26263v3, *SKILL.state: Scalable Long-Horizon Agent Skills*）。本文设计该论文机制在 ponda 中的工程化适配：以**显式结构化执行状态**取代对话历史堆叠，把长时任务的 prompt 从 O(T²) 累计 token 降到 O(T)。

## 1. 模块目标与需求映射

| 需求/来源 | 本文章节 |
|---|---|
| readme：长时任务上下文压缩（skill.state 模式） | 全文 |
| （用户决策 v1.1）严格按 SKILL.state 论文要求实现 | §6 严格性约束与要点清单 |
| 论文机制：`(P, Σ_t, O_t)` 输入三元组、`state_patch` 输出、推理即弃 | §2 / §3 |
| 与 pi 内置 compaction 的关系与分工 | §6 |
| 论文局限 → 检测与降级 | §7 |
| 环境开关：`runtime.contextStrategy: 'skill-state'`、`skillStateDomain` | §4 |

### 1.1 机制速览（论文要点，设计依据）

- 第 t 步模型**只**收到：任务规程 P（不可变）+ 结构化状态 Σ_t（JSON）+ 最新观察 O_t。历史观察/动作/推理永不进入 prompt。
- 模型输出：推理 R_t（生成后**丢弃**）+ 状态补丁 ΔΣ_t + 动作 a_t。运行时**确定性校验**补丁后按 `Σ_{t+1} = Σ_t ⊕ ΔΣ_t` 合并；⊕ 为带 **null 删除语义**的字典合并（value=null 即删 key）。
- 无效补丁触发 rollback-retry；schema 与校验归属运行时而非模型。
- 状态 schema **按领域**撰写（一个领域一套，跨任务复用），不是按任务。
- 实证：干扰鲁棒（无关遥测被状态更新过滤）、状态恢复零步、同预算下远胜滑窗/摘要压缩（结构化表示的收益，非单纯短 prompt）。

## 2. ponda 中的概念映射

| 论文概念 | ponda 对应物 |
|---|---|
| P（skill 规程） | goal 任务的规程提示（goal + deliverables + 工具约定 + schema 说明），由 goal/status-confirm 扩展生成（05 §3/§4） |
| Σ_t（执行状态） | `SkillStateEnvelope.state`（本文件 §3），随 session JSONL 持久化 |
| O_t（最新观察） | 最近的工具结果条目（tool_result） |
| ΔΣ_t | 模型回复中的 ` ```state-patch ` 围栏 JSON |
| a_t | 普通 pi 工具调用（不变） |
| R_t（即弃推理） | 模型的思考/正文（保留在 session 树中供审计，但不进入后续 prompt） |

**实现载体**：skill-state 模块（`extensions/skill-state/`），经 fork 补丁区域暴露的**上下文组装点**直接嵌入 agent 循环——论文 Algorithm 1 的"运行时"即 ponda 运行时，协议执行是**强制的原生路径**而非经通用 context 钩子的可选改写。会话 JSONL 仍完整记录一切（审计、history 搜索、07 数据捕捉不受影响）；**只有发给模型的视图被重写**。

## 3. 数据结构

```ts
/** 结构化执行状态信封（任务级，随 session 持久化 + 单独快照文件） */
interface SkillStateEnvelope {
  taskId: string;
  domain: string;                 // 领域 schema id，见 §4
  schemaId: string;               // 'coding-task@1'
  state: Record<string, unknown>; // 遵循领域 schema
  revision: number;               // 每次成功 ⊕ 递增
  updatedAt: string;
  history: { revision: number; patch: Record<string, unknown>; at: string }[];
  // history 仅供审计/回放（07 回测），不进入 prompt；可配置保留上限
}

/** 模型输出协议：回复文本中的围栏块 */
// ```state-patch
// { "state_patch": { "<path.to.key>": <value | null> } }
// ```

/** 运行时合并算子 ⊕（递归字典合并） */
function merge(state: Json, patch: Record<string, unknown | null>): Json {
  // 逐 key：
  //   value === null            → 删除该 key（点路径支持 "a.b.c"）
  //   两侧均为 plain object     → 递归合并
  //   其余                      → 覆盖标量/数组（数组整体替换，不做元素级合并——
  //                              论文小模型失败主因是"漏合并旧 key"，整体替换+显式写全量数组最稳）
}
```

校验规则（TypeBox，schema 定义与校验共用一份）：
- 补丁可解析为 JSON 对象且只含 `state_patch` 一个 key（允许多个围栏块时取最后一个并警告）。
- 应用后的 `Σ_{t+1}` **整体**通过领域 schema 校验（类型/必填/枚举）——比只校验补丁更强，直接防"漏合并旧 key"。
- 违规 → rollback-retry：将校验错误注入下一条用户侧消息（"你的 state_patch 无效：<错误>。当前状态为 <Σ_t>，请重新输出完整补丁"），重试上限 3，仍失败 → 降级（§7）并通知用户。

## 4. 领域 Schema

按领域撰写（论文原则）。ponda 内置 + 用户可扩展（放 `resources/`，kind 同 prompt 机制登记）：

```ts
// 内置领域：coding-task（goal 模式默认）
interface CodingTaskState {
  goal: string;                        // 任务目标（通常不变）
  phase: 'planning' | 'implementing' | 'verifying' | 'done';
  todos: { id: string; text: string; status: 'pending'|'doing'|'done'|'blocked' }[];
  filesTouched: { path: string; change: 'create'|'modify'|'delete'; summary: string }[];
  decisions: { at: string; choice: string; reason: string }[];   // 关键决策记录
  verification: { deliverable: string; status: 'unverified'|'passed'|'failed'; detail: string }[];
  openQuestions: string[];             // 待用户澄清的事项
  nextAction: string;                  // 下一步计划的一句话描述（论文 cmd_summary 的对应物）
}
```

- 内置领域另含：`research`（问题/假设/证据/结论）、`refactor`（目标结构/迁移映射/风险）。
- 用户自定义 schema：TypeBox 定义 + 说明文档为一个资源；`skillStateDomain` 引用其 id。
- schema 撰写规范（写入用户文档）：字段 ≤ 12 个、每个字段一句用途注释、枚举优先于自由文本、**状态必须是"未来执行的充分统计量"**（写不进状态的信息不该依赖历史）。
- 跨任务复用 memory：`memory/facts.json` 的键可在 schema 中声明为外部引用（如 `"$ref": "memory:facts"`），实现跨会话知识进入 Σ。

## 5. 运行时流程（与 pi 消息流的整合）

```
[上下文组装点（fork 补丁区域，原生）]（任务启用 skill-state 时）
  输入：完整消息历史 H
  1. 从 session 树提取：P（任务规程，由 goal 扩展注册的元数据）
     Σ_t（envelope，最近 revision）
     O_t（H 中最后一条 tool_result；无则取最后用户消息）
  2. 构造发送给模型的消息序列：
     system: P + schema 说明 + 输出协议说明（明示"你的推理将被丢弃，请把一切
             影响后续执行的结论写入 state_patch"——论文模板原文要求）
     user:   "Skill Execution State:\n```json\n<Σ_t>\n```\n\nLatest Observation:\n<O_t>"
  3. 返回该短上下文（pi 后续照常附加工具定义）

[message_end 钩子]
  4. 解析回复中的 state-patch 围栏块 → 校验 → ⊕ 合并 → envelope.revision++
     → 快照写 .ponda/state/<taskId>.json + 追加 session 树条目（审计）
  5. 失败 → rollback-retry（§3）；成功 → 该回复的推理正文不进入后续 prompt
```

- **每次一步**：skill-state 模式下 agent 每轮只推进一个动作（论文 Algorithm 1 语义）；pi 的多工具并行调用在该模式下限制为 1，其余场景不受影响。
- 工具调用（a_t）照常走 pi 工具管线与 sandbox（03）；O_t 即其结果。
- 用户中途插话 = 特殊 O_t（类型 `user_input`），并提示模型可经 `openQuestions`/状态回应。

## 6. 与 pi 内置 compaction 的分工

| | pi compaction | ponda skill-state |
|---|---|---|
| 机制 | 接近上限时**统计式摘要**压缩历史 | **结构性替换**：只发 P+Σ+O |
| 语义保真 | 有损（摘要丢细节） | 状态即契约，无歧义 |
| 适用 | 普通对话式会话（默认） | goal/长时任务、swarm 子 agent |
| 关系 | 仅两处：非任务会话的默认策略；skill-state 失效场景（§7）的降级目标 | 主策略（goal/长时任务/swarm 子 agent） |

`runtime.contextStrategy` 决定会话默认；goal 任务强制 skill-state（05 §3）。

**严格性约束（v1.1 决策：按论文要求执行）**：Σ 是"未来执行的充分统计量"，**禁止对 Σ 做摘要压缩**——Σ 膨胀超限时唯一处置是**任务拆分**（强制把当前任务分解为子任务、各自独立 Σ，父任务只保留聚合视图）。compaction 不得作用于 skill-state 任务的 Σ，也不得成为 skill-state 协议内的"逃生通道"。

按论文要求严格执行的要点清单（评审与实现均以此为准）：

- 模型每步输入**只有** `(P, Σ_t, O_t)`——无历史观察/动作/推理，不提供读取自身历史的"逃生门"工具（仅 §7 降级模式开放）；
- 每步**单个动作**（a_t 唯一，禁止一轮多工具并行）；
- 推理 R_t 生成后即弃，**绝不进入后续 prompt**（session 树留档仅供审计）；
- 状态补丁协议：单一 `state_patch` key、点路径、null 删除；
- schema 与校验**归属确定性运行时**（TypeBox），模型不可自定义状态结构；
- 无效补丁一律 rollback-retry（≤3 次），不允许"带病合并"；
- 领域 schema **按领域撰写、跨任务复用**，不为单任务 bespoke schema；
- 状态是未来执行的充分统计量：Σ 超限只拆任务、不压缩 Σ（见上）。

## 7. 失效场景、检测与降级（论文局限的工程化）

| 失效场景（论文） | 检测信号 | 处置 |
|---|---|---|
| 无固定 schema / 状态结构需执行中动态发现 | 补丁频繁增删新 key（revision 内 key 集合抖动 > 阈值） | 提示切换领域 schema 或转 pi-compaction |
| 依赖"当时未写入状态"的早期观察 | rollback-retry 率升高；模型在推理中翻找历史（请求 `session.read` 类动作） | 降级：该任务回退完整历史 + compaction，并把已积累的 Σ 作为首条注入 |
| 任务目标定义在历史轨迹上（审计/溯源类） | goal 解析出 `audit/explain` 类目标关键词；deliverables 含"过程报告" | 建议不启用；坚持使用则保留 `history` 并在收尾报告中使用 |

降级动作记录 telemetry（07），用于后续统计 skill-state 适用边界。

**小模型防御**（论文实验：小模型 68% 失败源于状态覆盖/漏合并）：整体状态校验（§3）+ schema 内置示例值 + `nextAction` 强制字段（引导模型每步总结）+ 预留语法约束解码接口（provider 侧支持 structured output 时启用，`ProviderDef` 增设 `supportsJsonSchema` 探测，见 02 §6）。

## 8. 边界情况与开放问题

- **会话 resume**：envelope 快照与 session 树一致性校验（revision 前缀匹配），不一致以 session 树重放重建。
- **swarm 共享状态**：多 agent 并发写 Σ 需冲突解决（论文列为开放问题）——ponda 采用**黑板分片**：子 agent 各自 envelope，父任务状态仅由主 agent 合并子结果（05 §6），规避并发 ⊕。
- **OQ**（00 §9 Q5）：降级判据的量化阈值（抖动率、retry 率）需 M7 里程碑用实测数据标定。
- **OQ**：是否允许模型读取自身历史（`session.replay` 工具）作为逃生门——当前设计禁止（保持 O(T) 优势），仅在降级模式开放。
