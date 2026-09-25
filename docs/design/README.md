# ponda 设计方案

基于 pi coding agent 的环境管理软件。本目录是 ponda 的**详细设计方案**（v1.1，含三项用户决策修订），由 readme.md 的需求推导而来，作为实施前的评审基线。设计与实现推进中本文档集持续演进。

调研依据：
- pi（`earendil-works/pi`，npm `@earendil-works/pi-coding-agent`）的公开扩展机制：agent dir、extension API、pi-ai/pi-tui/pi-agent-core、packages 体系。
- SKILL.state 论文（`2608.26263v3.pdf`，arXiv:2608.26263v3）：结构化执行状态的上下文管理。

## 关键决策记录

| 日期 | 决策 | 影响 |
|---|---|---|
| 2026-09-25 | ponda 采用 **pi fork** 方案（替代 v1 的外挂编排层） | 00 §1.1/§5：补丁区域清单（PATCHES.md）+ 上游 rebase 流程；TUI、上下文管理、沙箱均可原生集成 |
| 2026-09-25 | 沙箱引入**容器化**（Docker/Podman）强化强制隔离与 overlayfs 审计 | 03 §2/§2.1；无容器环境降级为审计型沙箱 |
| 2026-09-25 | 上下文管理**严格按 SKILL.state 论文要求**实现 | 06 §6：严格性要点清单；Σ 禁止摘要压缩、超限只能任务拆分；协议为原生强制路径 |

## 阅读顺序

| # | 文档 | 一句话摘要 |
|---|---|---|
| 1 | [00-overview.md](00-overview.md) | 定位、分层架构、概念模型、目录约定、monorepo 结构、技术选型 |
| 2 | [01-environment.md](01-environment.md) | 环境数据模型、CLI 规格、继承合并语义、shell 集成、配置驱动 |
| 3 | [02-resources.md](02-resources.md) | 七类资源统一管理、资源池+软链接注入、provider 向导、history、免切换操作 |
| 4 | [03-sandbox.md](03-sandbox.md) | 三模式沙箱（快照/worktree/临时工作区）、追踪回滚结算、权限模型 |
| 5 | [05-runtime.md](05-runtime.md) | daemon 进程模型、todolist、goal、成果契约与确认、agent swarm |
| 6 | [04-tui.md](04-tui.md) | 三栏 TUI 布局规格、渲染能力、弹窗系统、键位、组件映射 |
| 7 | [06-context.md](06-context.md) | SKILL.state 适配：领域 schema、state patch 协议、降级策略 |
| 8 | [07-data.md](07-data.md) | telemetry 事件模型详设、指标层、RL 数据集与回测接口预留 |
| 9 | [08-wiki.md](08-wiki.md) | `.wiki/` 知识库：结构、增量构建、检索加速 |
| 10 | [09-roadmap.md](09-roadmap.md) | M0–M10 里程碑、验收标准、风险登记表 |

建议首读 00 建立全局图景，再按 01→02→03→05→04→06 的顺序深入（04 放在 05 之后是因为 TUI 大量消费运行时扩展的事件）。

## 术语表

| 术语 | 定义 | 定义处 |
|---|---|---|
| 环境（Environment） | 命名隔离的 agent 运行单位，物化为一个 pi agent dir + manifest | 00 §3 |
| agent dir | pi 的配置目录（settings/SYSTEM.md/skills/extensions/themes/sessions），ponda 中即环境目录 | 00 §1.1 |
| manifest（`manifest.json`） | 环境的唯一事实源，渲染成 pi 消费的全部配置文件 | 01 §2 |
| 渲染（render） | manifest → settings.json/SYSTEM.md/models.json/mcp.json 的幂等生成过程 | 01 §2.2 |
| 继承（base） | 环境按 DAG 逐层合并配置的机制 | 01 §3 |
| 资源（Resource） | 可被环境启用的受管实体（skill/tool/prompt/extension/theme/provider/model/mcp-server） | 02 §2 |
| 资源池 | `~/.ponda/resources/`，资源实体唯一存放地 | 02 §3 |
| 软链接注入 | 将池内资源以相对软链接放进环境目录，实现"共享实体 + 环境隔离" | 02 §3 |
| 工作区（workspace） | pi 进程 cwd 所在的项目目录，沙箱与 wiki 的作用边界 | 03 §3 |
| 沙箱活动（SandboxActivity） | 一次受隔离的修改活动（inplace 快照 / worktree / 临时工作区） | 03 §6.1 |
| 快照分支 | `ponda/snapshots/<session>`，每轮次自动提交的追踪分支 | 03 §5.2 |
| worktree | git linked worktree，并行/试验性修改的独立工作区（`ponda/wt/*` 分支） | 03 §5.3 |
| 临时工作区 | 工作区外文件操作的副本沙箱（`~/.ponda/sandboxes/`），写回需确认 | 03 §4 |
| 结算（settle） | 沙箱活动向用户分支应用/丢弃的确认流程 | 03 §6.2 |
| 权限申请（PermissionRequest） | 越权动作的用户审批流（once/session/env-always/deny） | 03 §7.2 |
| daemon | 每环境一个的常驻 agent 进程，承载后台存活 | 05 §5.1 |
| attach / detach | TUI 连接/离开某会话；detach 不中断执行 | 05 §5.2 |
| goal 任务 | 有目标、成果契约与状态机的长时任务 | 05 §3 |
| 成果契约（DeliverableSpec） | 任务计划产出清单条目：描述+判据+校准方式 | 05 §4.1 |
| 校准代码 | 成果确认后生成的自动验证脚本（`.ponda/verify/`） | 05 §4.2 |
| envelope（SkillStateEnvelope） | skill-state 的结构化执行状态信封（Σ） | 06 §3 |
| state patch | 模型输出的状态补丁（`state_patch` 围栏块，null 删除语义） | 06 §3 |
| ⊕ 合并 | 带空值删除的递归字典合并算子 | 06 §3 |
| 领域 schema | 按领域（非按任务）定义的状态结构（如 `coding-task@1`） | 06 §4 |
| swarm cell | swarm 中的一个子 agent 实例（独立会话+可选 worktree） | 05 §6.1 |
| 信箱（mailbox） | cell 间的定向消息机制，收件即作为 O_t 投递 | 05 §6.2 |
| 补丁区域（PATCHES.md） | fork 中对上游包全部改动的登记清单与护栏测试映射 | 00 §5 |
| 上游同步（rebase 流程） | fork 跟进 earendil-works/pi 的节奏与冲突处理流程 | 00 §1.1 |
| 容器后端（ContainerBackend） | 每会话容器的 Docker/Podman 抽象层：挂载/网络/资源/overlay 审计 | 03 §2.1 |
| 降级链（audit-only） | 无容器运行时退回审计型沙箱的路径与收紧策略 | 03 §2.1 |
| telemetry 事件流 | `~/.ponda/telemetry/events/*.jsonl` 的脱敏事实流 | 07 §2 |
| metrics.db | 事件流 ETL 出的 SQLite 指标层 | 07 §4 |
| 数据集导出 | RL 预留的轨迹样本导出（digest/full 两级） | 07 §6 |
| 回测（replay） | 变体策略下重新采样运行并按冻结指标对比（接口预留） | 07 §7 |
| wiki 页面 / scope / confidence | `.wiki/` 条目 / 覆盖路径前缀 / 未复验衰减置信度 | 08 §2 |

## 需求追踪矩阵（readme → 设计）

readme 逐条需求与落点对照。**状态**：✅ 已覆盖 / ⚠️ 部分覆盖（设计留有开放问题）。

| readme 需求（节选自 readme.md） | 落点 | 状态 |
|---|---|---|
| 每个agent独立：system prompt/工具集/skill/MCP/extension/运行时策略/记忆/快捷键/主题 | 00 §3、01 §2.1（manifest 各节） | ✅ |
| `ponda env create / rm / activate` | 01 §4.1–4.3 | ✅ |
| `--base` 环境继承 | 01 §3 | ✅ |
| 默认 pi 配置文件示例（system_prompt/tools/skills/prompt/privileges） | 01 §2.3 | ✅ |
| shell 快捷键快速切换/执行常用命令 | 01 §6.3 | ✅ |
| 提示符 `(pi:default)` 随切换自动更新 | 01 §6.2 | ✅ |
| 沙箱：系统调用与文件操作均在沙箱进行 | 03 §2/§7 | ✅ 容器强制隔离 + overlay 审计（v1.1 决策；无容器降级审计型） |
| 工作区外文件 → 临时工作区拷贝、原文件不自动删除 | 03 §4 | ✅ |
| 工作区内 → 无 git 则自动创建，修改可追踪回滚 | 03 §5.1 | ✅ |
| worktree + git 实现隔离 | 03 §5.2–5.3 | ✅ |
| 用户确认后生成 commit；git log 查看、git checkout 回滚 | 03 §6.2 | ✅ |
| 合并操作提示用户手动确认 | 03 §6.3 | ✅ |
| 切换环境后 pi 连接不同执行文件目录 | 01 §5 | ✅ |
| skills 等独立目录 + 软链接到当前环境执行目录 | 02 §3 | ✅ |
| `ponda skills/tools/extension/theme list/add/rm/update/info` | 02 §4 | ✅ |
| `ponda provider/model ...` 交互式配置 | 02 §6 | ✅ |
| `ponda prompt list/add/rm/update/info` | 02 §4 | ✅ |
| `ponda memory reset` | 02 §7 | ✅ |
| `ponda history list/attach/rm/info/search` | 02 §8 | ✅ |
| 配置文件自动创建和切换环境 | 01 §7 | ✅ |
| 免切换操作 `ponda <env> skill list` | 02 §9 | ✅ |
| `ponda tui` 三栏界面 | 04 §2–3 | ✅ |
| 左栏：按工作区会话列表、token 消耗；文件列表切换、逐级展开、点开文件 | 04 §4.1–4.2 | ✅ |
| 左栏底部：当前与所有 agent 的 token/费用 | 04 §4.3 | ✅ |
| 中栏：markdown/代码高亮/图片/表格/数学公式 | 04 §5.2 | ⚠️ 公式为 Unicode 近似一级方案（Q4） |
| 思考折叠、子步骤折叠 | 04 §5.3 | ✅ |
| 输入框：@引用、/命令、模型/思考强度/上下文窗口/模式切换 | 04 §5.4 | ✅ |
| 活跃子 agent 显示与切换 | 04 §5.5、05 §6.3 | ✅ |
| markdown 超链接 → 主体显示、标签页切换 | 04 §5.6/§5.1 | ✅ |
| 右栏：todolist、子任务进度与状态 | 04 §4.3、05 §2 | ✅ |
| 任务权限申请弹窗快速选择 | 03 §7.2、04 §6 | ✅ |
| todolist：长任务切分子任务并独立管理跟踪 | 05 §2 | ✅ |
| goal 模式 | 05 §3 | ✅ |
| 后台对话存活（切换会话不中断） | 05 §5 | ✅ |
| 状态描述和确认（清单/确认/校准代码/收尾比对/变更审批/右栏常驻） | 05 §4 | ✅ |
| 上下文压缩：skill.state 模式（参照论文） | 06 | ✅ 严格按论文协议（06 §6 要点清单，v1.1 决策） |
| agent swarm（子 agent 生成、通信协作） | 05 §6 | ✅ |
| `.wiki/` 项目知识库加速检索 | 08 | ✅ |
| 数据捕捉软件（提升 skills 可用性稳定性） | 07 §2–§5 | ✅ |
| 回测与数据分析（优化环境管理策略） | 07 §7（接口冻结）/§5（日常分析） | ⚠️ 回测执行器后置 M11+（已确认的范围决策） |
| 通过强化学习提升 skills | 07 §6（数据闭环预留） | ⚠️ 训练框架不在 ponda 内（已确认的范围决策） |

## 文档写作规范（供后续修订遵循）

- 模块文档统一结构：模块目标与需求映射 → 数据结构（TS 接口+示例）→ 命令/交互规格 → 关键流程 → 与 pi 集成方式 → 边界情况与开放问题。
- 全文中文；代码、命令、字段名、路径用英文。
- 开放问题统一编号（各文档 §末 + 00 §9 汇总），修订时闭环销号。
