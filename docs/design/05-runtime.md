# 05 · Agent 运行时扩展（todolist / goal / 状态确认 / 后台存活 / swarm）

> 运行时模块是 ponda 注入 agent 进程的能力集合（L3 层；fork 后以 extension 形态组织、可经内核挂载点深度集成，00 §1.1），彼此通过 protocol 包的事件总线协作，并向 TUI（L4）与 telemetry 供数。本文同时定义承载"后台对话存活"的 daemon 进程模型。

## 1. 运行时扩展总览与 RuntimePolicy

| 扩展 | 职责 | 依赖 |
|---|---|---|
| ponda-core-ext | 常驻：环境标识注入 system prompt、command 工具注册、memory 工具、telemetry 埋点、权限事件总线 | protocol, telemetry |
| sandbox-guard | 03 全部（含容器后端，经 packages/sandbox） | packages/sandbox |
| todolist | §2 | ponda-core-ext |
| goal + status-confirm | §3 / §4（两者成对：goal 管循环，status-confirm 管成果契约） | todolist, skill-state |
| skill-state | 06 | — |
| swarm | §6 | sandbox(worktree), protocol |
| wiki | 08 | — |

`RuntimePolicy`（manifest 字段，定义见 01 §2.1）语义：

- `backgroundLiveness`：本环境会话是否默认挂到 daemon（§5）。
- `contextStrategy`：会话默认上下文策略；goal 任务强制 skill-state（§3）。
- `permissionMode`：会话初始权限模式 `plan | approve | full-auto`（语义见 03 §7.3），会话中可切换（04 §5.4），切换本身是一个权限敏感动作（收紧随意、放宽需确认）。
- `maxParallelSubagents`：swarm 并发熔断上限（§6）。

## 2. todolist 扩展（长任务的子任务分解与跟踪）

readme："pi agent 能够将一个长时任务切分成多个子任务，并且能够对每个子任务进行独立的管理和跟踪"。

### 2.1 数据模型

```ts
interface TodoItem {
  id: string;                  // 't1', 't1.2'
  parent: string | null;       // 树形，根为任务本身
  text: string;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
  blockedReason?: string;
  createdAt: string; updatedAt: string;
  refs?: { deliverable?: string; sandboxActivity?: string };  // 关联成果(§4)/沙箱活动(03 §6)
}
interface TodoBoard { taskId: string | 'session'; items: TodoItem[]; revision: number; }
```

- 存储随 session 树持久化（追加条目 + 当前快照），TUI 右栏与 `ponda todo ls`（CLI）共享。
- 系统提示注入："处理长任务时先调用 todo_write 建立分解；每次只把一个子任务置 in_progress"。

### 2.2 工具面

| 工具 | 参数 | 说明 |
|---|---|---|
| `todo_write` | `{ ops: [{op:'add'|'update'|'remove', id?, text?, status?, parent?}] }` | 批量操作，单次原子；`update` 需带 revision 乐观锁 |
| `todo_read` | `{}` | 返回全量看板 |

事件：看板每次变更发 `todo.updated` 事件（TUI 右栏实时刷新，telemetry 记录任务粒度进度）。

## 3. Goal 模式

readme："用户可以给 agent 设置一个目标，agent 根据目标进行任务分解和任务执行"。

### 3.1 入口

- CLI：`ponda goal start "<目标描述>" [--workspace .] [--mode plan|approve|full-auto]`（在当前环境开任务会话）；`ponda goal ls / status <id> / cancel <id>`。
- TUI：输入框以 `--goal <text>` 前缀发起，或 `/goal <text>`。
- 环境配置 `runtime.skillStateDomain` 指定领域 schema；缺省 `coding-task`。

### 3.2 任务生命周期

```
created → planning → confirmed → executing → verifying → settled → closed
            │          │            │           │           │
            │          └ 用户确认成果清单 ┘ verification  └ 用户确认合并/提交（03 §6.3）
            └ 计划被拒 → re-planning（≤2 次，之后要求用户改目标）
```

1. **planning**：agent 产出（a）任务分解（TodoBoard）；（b）**任务计划产出清单**——成果契约 DeliverableSpec[]（§4.1）；（c）每个成果的状态描述。skill-state 模式下这些直接以 Σ 的 `todos/verification` 字段承载（06 §4）。
2. **confirmed**：用户审阅成果清单并确认（TUI 弹窗 / CLI 交互确认）。确认即**冻结基线**（可后续走变更审批，§4.3）。
3. **executing**：论文式循环——每轮 (Σ_t, O_t) → state_patch + 单步动作；todo 看板随之更新；沙箱活动按 03 进行。
4. **verifying**：任务临近结束时运行校准代码比对成果（§4.2）。
5. **settled/closed**：合并确认（03 §6.3）→ 最终报告（成果状态 + token/费用 + 修改清单）。

goal 任务强制启用 skill-state 上下文策略（06），Σ 的 `phase` 字段驱动上述状态机（phase 变更即任务阶段事件，telemetry 记录）。

## 4. 状态描述与确认机制

readme 原文要求逐条对应：

> "第一步不仅是做计划和任务拆分，更需要生成一个任务计划产出清单，和每个成果的状态描述，交给用户进行确认；确认后生成状态自动确认校准代码；当任务快要结束的时候要比对成果状态；执行过程中如果需要切换状态的话，需要提前申请用户同意；状态在执行过程中，会一直展示在右边栏中"。

### 4.1 成果契约（计划产出清单 + 状态描述）

```ts
interface DeliverableSpec {
  id: string;                    // 'd1'
  name: string;                  // 成果名，如 "导出 CSV 的 CLI 子命令"
  description: string;           // 状态描述：完成后的可观察形态
  doneCriteria: string;          // 自然语言的完成判据（给用户看的）
  verify:                        // 校准方式（给机器跑的）
    | { type: 'command'; command: string; expectExit: 0; expectOutputContains?: string }
    | { type: 'test'; framework: 'vitest'|'jest'|'pytest'|'go-test'; target: string }
    | { type: 'manual' };        // 无法自动校准时的人工核验项
  artifacts?: string[];          // 预期产出路径（相对 workspace）
  status: 'planned' | 'in_progress' | 'delivered' | 'verified' | 'failed'
        | 'changed-pending';     // 变更待批（§4.3）
  lastVerify?: { at: string; passed: boolean; detail: string };
}
```

用户确认的内容 = 清单全量（名称、状态描述、完成判据、校准命令）。确认动作记录于 session 树与 telemetry（`task.deliverables.confirmed`）。

### 4.2 校准代码（自动确认校验）

确认通过后，status-confirm 扩展把每个可自动校准的成果编译为**校准脚本**，落盘 `<workspace>/.ponda/verify/<task-id>/d<N>.<sh|py>` + `verify.json`（清单与运行配置：cwd、超时、环境变量白名单）。

- 生成即**试跑一次**（应处于未完成→失败/通过皆有可能，结果仅作基线记录）；试跑需要执行权限（03 §7）。
- **收尾比对**：任务进入 verifying 阶段（Σ.phase 变更或 agent 声明完成）时逐项运行校准脚本；全绿 → `verified`；有失败 → 差异报告回传 agent（允许修复后重跑，重跑 ≤3 轮），仍失败则如实报告用户。
- `manual` 型成果：生成核验清单文本，最终报告里留给用户勾选确认。
- 校准脚本受沙箱执行策略约束（read-only 命令直接跑；有副作用的测试框架标记并申请权限）。

### 4.3 执行中的状态变更审批

- 任何对已确认成果契约的修改（新增/删除成果、改 doneCriteria/verify/artifacts）必须先申请：agent 发 `deliverable.change_request`（变更 diff + 理由）→ 用户弹窗批准 → 才写入契约（新 revision，旧版留档）。
- 未批准而产出偏离契约的修改：收尾比对会暴露（校准失败/多余文件），最终报告标记"超出契约范围"。
- 右栏常驻展示：TUI 右侧面板固定渲染当前任务的成果状态表（id、名称、状态、最近校准结果），见 04 §4.3。

## 5. 后台对话存活（daemon 进程模型）

readme："当用户输入完要求后，切换到不同会话的时候，任务执行不会中断，会在后台持续执行"。

### 5.1 进程拓扑

```
ponda-agent daemon（每环境一个，常驻，懒启动）
  ├─ 持有该环境全部活跃会话的 agent 循环（fork 内 pi-agent-core 实例）
  ├─ 会话状态写 JSONL（pi 原生），Task/Todo/Deliverable 快照落 .ponda/
  ├─ 暴露 Unix socket：~/.ponda/daemon/<env>.sock（protocol 包，JSON-RPC）
  └─ 生命周期：`ponda env activate` 触发懒启动；空闲 30min 且无 running 任务自动退出
                （`ponda daemon stop [--env]` 手动停）

ponda tui（前端）── attach/detach ──▶ daemon
ponda <cli 直启>（不经 daemon 的会话）：沙箱与运行时模块照常生效，但无后台存活
```

### 5.2 attach / detach 语义

- **切换会话 = TUI 侧 detach**：UI 释放对旧会话的订阅；daemon 中该会话继续执行（工具调用、状态更新、写盘不停）。
- 重新选中该会话 = attach：TUI 从 session JSONL + 快照重建视图，订阅后续事件流（增量同步基于 entry id 游标）。
- 会话运行完成/需要确认（权限申请、成果确认、合并确认）而 UI 未 attach → daemon 通知（终端 bell + 系统通知 `osascript`/`notify-send`）+ `ponda history list` 中状态仍为 `running`→`waiting-confirmation`。
- daemon 崩溃恢复：会话事实全部在磁盘（JSONL/快照），重启 daemon 后 running 会话标记 `interrupted`，`ponda goal resume <task-id>` 依托 skill-state envelope 恢复（这正是结构化状态的红利：恢复不依赖历史重放）。

### 5.3 RPC 接口（protocol 包，摘要）

| 方法/事件 | 方向 | 用途 |
|---|---|---|
| `session.list / session.new / session.attach / session.detach / session.send` | TUI→daemon | 会话管理 |
| `session.events`（流） | daemon→TUI | 消息/工具/todo/deliverable/权限事件 |
| `permission.respond` | TUI→daemon | 弹窗应答（03 §7.2） |
| `task.status / task.cancel` | TUI→daemon | 任务查询/取消（取消走结算确认） |
| `cost.snapshot` | daemon→TUI | token/费用累计（左栏底栏，04 §3） |

## 6. Agent Swarm

readme："多个 agent 协同工作……agent 在执行过程中可以根据任务，构建起多个子 agent，子 agent 之间可以进行通信和协作，完成任务的不同部分"。

### 6.1 模型

```ts
interface SubagentSpec {
  role: string;                 // '探索者' | '实现者' | '审校者' | 自定义
  brief: string;                // 子任务简报（目标 + 边界 + 产出契约）
  model?: string;               // 可用更便宜模型，缺省继承环境
  skills?: string[];            // 子 agent 专属 skill 子集（省 token）
  workspaceMode: 'shared-worktree' | 'own-worktree' | 'read-only';
}
interface SwarmCell { subagentId: string; spec: SubagentSpec; sessionId: string;
  status: 'spawning'|'running'|'done'|'failed'|'cancelled'; cost: { tokens: number; usd: number }; }
```

- 主 agent 经 `spawn_subagent(spec)` 工具创建子 agent（swarm 扩展实现）：每个子 agent 是 daemon 中的**独立会话**（独立 session JSONL、可独立模型/skill 集），并发受 `maxParallelSubagents` 熔断。
- **写隔离**：子 agent 默认 `own-worktree`（03 §5.3，分支 `ponda/wt/swarm-<cell>`）；只读分析型用 `read-only`（写权限不授予）；产出合并回主任务结算，合并照旧需用户确认。
- **状态合并**：子 agent 各自维护 envelope（06 §8 分片策略），`done` 时向主 agent 递交结果摘要（brief 的产出契约对应物），主 agent 将其并入父任务 Σ（仅主 agent 有父状态写权）。

### 6.2 通信

| 工具 | 语义 |
|---|---|
| `send_message(to, payload)` | 定向信箱：目标 cell 下次被调度时作为 O_t 收到；主↔子、子↔子均可 |
| `read_messages(filter?)` | 取信箱（收件即标记，防重复消费） |
| `swarm_status()` | 全 cell 状态/费用快照（主 agent 与 TUI 共用数据源） |
| `cancel_subagent(id)` | 主 agent 取消（走子 agent 会话的结算确认） |

调度器（daemon 内）：简单池化——cell 就绪即占一个并发位；cell 失败自动重试 1 次（附失败摘要），再失败上报主 agent 决策。费用熔断：swarm 总费用超环境阈值（`runtime.maxParallelSubagents` 之外的 `maxSwarmCostUsd`，默认 $5）暂停 spawning 并询问用户。

### 6.3 TUI 集成

对话窗口上方的**活跃子 agent 切换条**（04 §5.5）：每个 cell 一个入口（角色名 + 状态色点），点击将中栏切换到该子 agent 会话的只读/可插话视图（插话 = 向其信箱发消息）。

## 7. 边界情况与开放问题

- **扩展间顺序**：context 重写（skill-state）必须在 sandbox 的路径重写决策之后、发送之前——以 pi 钩子注册顺序显式约定（ponda-core-ext 统一编排注册顺序）。
- **daemon 与 CLI 直启冲突**：同一会话不允许 daemon 与直启 pi 同时写（会话文件锁；后者提示转 attach）。
- **goal 任务的取消**：取消 = 停止调度 + 进入结算（未完成成果标记 cancelled，沙箱活动按 discard 或保留待定）。
- **OQ**（00 §9 Q3）：swarm 费用熔断的默认值与按环境配置粒度。
- **OQ**：子 agent 是否可再嵌套 spawn（当前设计允许一层，深层递归的收益/风险待实测）。
