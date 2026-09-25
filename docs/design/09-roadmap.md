# 09 · 实施路线

> 里程碑按依赖顺序排列；每个里程碑给出范围、交付物与验收标准。原则：**每个里程碑结束时 ponda 都可被真实使用**（哪怕功能子集）。
>
> **实施进度（2026-09-25）**：M0 ✅、M1 ✅、M2 ✅（registry 通道除外）、M3 核心 ✅（容器后端与 pi 运行时接入待做）、M4 ✅（packages/rpc + packages/daemon）、**M5 ✅（三栏读视图 + 交互全集）、M6 ✅（goal 状态机/成果契约确认/校准代码与收尾比对/契约变更审批/右栏成果状态 + ponda goal CLI；真实 agent planning 由 P4 接入）、M8 ✅（SwarmRuntime：cell 生成/own-worktree 写隔离/信箱通信/并发与费用熔断/失败重试/TUI 切换条与插话；真实 spawn_subagent 工具经 P4 接入主 agent）、M9 ✅（WikiStore：目录/frontmatter 规范、首次+增量构建、confidence 衰减复验、倒排索引检索、wiki_search/read/update 工具注册、TUI @ 补全含 .wiki；语义索引与 agent 自动触发待 P4）、**M3 ✅（容器后端：Docker/Podman 抽象 + 三域 bind-mount 推导 + overlayfs 上层 diff 审计与 git 快照交叉比对 + 无容器降级链 audit-only/高危默认拒绝 + ponda sandbox backend；真实镜像构建与 bash 工具容器内执行随 P4）、运行时接入 P1 ✅（pi getAgentDir 原生读 ponda state.json）+ **P4 ✅（真实 agent 循环）、M2 ✅（registry npm:/git: 安装通道）、M10 ✅（ponda stats CLI）、P3 ✅（skill-state (P,Σ,O) 协议接入 PiAgentLoop）**、M7 核心 ✅（⊕ 合并/协议校验/领域 schema；接入待 P1）、M10 核心 ✅（事件模型/脱敏/JSONL sink/技能指标；CLI 呈现待做）。详见 PONDA.md 与 git 提交记录。

## 1. 里程碑总览与依赖图

```
M0 脚手架
 └─ M1 环境核心 ──┬─ M2 资源管理 ──┬─ M3 沙箱 ──┬─ M4 运行时 I ── M5 TUI ── M6 goal+状态确认 ── M7 skill-state*
                 │                │            │        （daemon/todo/权限） │        （也可与 M6 并行开发，联调在 M6 后）
                 │                │            └──────── M8 swarm（依赖 M5 的切换条、M3 的 worktree）
                 │                └─ M10 数据捕捉（依赖 M2 的资源版本化；stats 可随时跟进）
                 └─ M9 wiki（仅依赖 M1/M2，位置灵活，建议 M8 后）
```

## 2. 里程碑明细

### M0 · Fork 基线与基础设施（~1 周）

- 范围：fork earendil-works/pi monorepo（upstream remote + 基线 commit 登记）、`ponda` 入口（含 `ponda pi` 透传原生命令）、`PATCHES.md` 补丁区域清单与护栏测试框架、TS/ESM/Node22 配置、lint/test（vitest）、CI、`packages/protocol` 骨架、首次 rebase 演练（同步一个上游 patch 版本验证流程）。
- 验收：CI 绿；`ponda --version` 可执行；`ponda doctor` 报告 fork 基线与上游差距；rebase 演练完成且护栏测试能捕获至少一类冲突。

### M1 · 环境核心（~1.5 周）

- 范围：EnvManifest 模型与校验、继承合并引擎（01 §3 全策略表）、`env create/rm/activate/list/info/diff/export/import/doctor`、渲染器（settings/SYSTEM/models/mcp/keybindings）、state.json 原子切换 + 入口原生读取（01 §5 补丁区域）、`ponda init` + bash/zsh/fish 集成（提示符/快捷键）、chpwd 自动激活。
- 验收：两环境各自 `ponda` 启动后 system prompt/skills/主题互不串扰；`env doctor` 零漂移；shell 提示符 `(pi:<env>)` 实时更新。
- 风险：入口读 state 的补丁与上游入口改动冲突（护栏测试盯防）。

### M2 · 资源管理（~1.5 周）

- 范围：资源池与 resource.json、registry 安装（复用 pi install 解析）、软链接注入与 linkMode 降级、七类资源通用命令、command tool 注册（经 ponda-core-ext）、provider/model 交互式向导、memory 管理、history 索引与五命令、免切换语法 `ponda <env> <group> ...`。
- 验收：readme 中全部 `ponda xxx list/add/rm/update/info` 命令行为符合 02 §4 表格；跨环境装/卸资源互不影响；`history attach` 能以正确环境恢复会话。

### M3 · 沙箱与隔离（~3 周）

- 范围：sandbox-guard（工具执行管线拦截/路径重写/命令静态分析，fork 挂载点）、**容器后端**（Docker/Podman 抽象层、每会话容器、bind-mount 清单按三域推导、overlayfs 审计通道、网络/资源策略、无容器降级链）、三模式路由（inplace 快照链 / worktree / 临时工作区）、autoGitInit、结算与合并确认（CLI 交互版，git/overlay 双证据比对）、rollback、权限请求/应答/`env-always` 回写、权限模式三档。
- 验收：03 §4/§5/§6 验收剧本全部通过；容器内 bash 视野=挂载清单（越界写不可达）；overlay diff 与 git 快照交叉审计可用；卸载 Docker 后降级链生效且高危命令默认拒绝。

### M4 · 运行时扩展 I：daemon 与 todolist（~1.5 周）

- 范围：daemon 进程模型与 RPC（05 §5.3 接口全量）、attach/detach、后台存活与通知、崩溃恢复（interrupted 标记）、todolist 工具与事件、CLI 侧 `ponda goal ls/status`（先无 goal 引擎）、`ponda todo ls`。
- 验收：TUI 未就绪前用 CLI + `pi --mode rpc` 冒烟：会话切走后任务继续、通知可达、daemon 重启后 `goal resume` 语义正确（基于已有 envelope 或标记 interrupted）。

### M5 · TUI（~2 周，自研运行时 @ponda/tui【opencode 范式】；可与 M6 部分并行）

- 范围：三栏布局全量（04 §4/§5）、标签页系统、渲染管线（markdown/高亮/图片/公式一级方案）、思考与子步骤折叠、@ 引用与 / 命令补全、模式/模型/思考强度切换、子 agent 切换条（数据接口先于 swarm 落地）、弹窗系统（权限/合并/成果确认/变更审批）、键位与命令面板、无头快照测试（renderStateFrame）。
- 实施记录：原方案为改造 fork 内 pi TUI（TuiMainScreen 渲染根）；2026-09 重构为 `packages/tui-next`（`@ponda/tui`）：solid 风格信号 + 声明式组件 + flexbox + cell buffer 行差分 + 分层 keymap（04 §2/§8），不再依赖 pi-tui（PATCHES P2）。
- 验收：04 §3 ASCII 图的全部交互逐条可演示；TUI 崩溃不中断后台任务；<100 列降级布局可用。

### M6 · Goal 模式 + 状态描述与确认（~2 周）

- 范围：goal 生命周期状态机、成果契约（DeliverableSpec）与用户确认流、校准代码生成与收尾比对、变更审批、右栏常驻成果状态（TUI 已就绪）、`ponda goal start/ls/status/cancel/resume`。
- 验收：readme"状态描述和确认"段落的五个行为（清单确认/校准生成/收尾比对/变更需批准/右栏常驻）端到端演示通过。

### M7 · skill-state 上下文管理（~1.5 周，开发可提前，联调在 M6 后）

- 范围：领域 schema 三内置 + 自定义机制、上下文组装点原生集成（06 §2）、state-patch 解析/校验/⊕ 合并/rollback-retry、envelope 持久化与 resume 重建、**严格性约束**（Σ 禁止摘要、超限任务拆分，06 §6 要点清单逐条实现）、失效检测与降级、小模型防御、memory facts 引用。
- 验收：06 §7 三类失效场景的检测与降级路径有测试；100 步长时任务 prompt 尺寸稳定（不随步数线性增长）；降级事件入 telemetry。

### M8 · Agent Swarm（~2 周）

- 范围：spawn/调度/并发熔断、own-worktree 写隔离、信箱通信、子 agent envelope 分片与父状态合并、费用熔断、TUI 切换条与插话、取消与结算。
- 验收：三 cell 协作任务演示（探索/实现/审校）；合并回主任务需用户确认；超配额自动暂停 spawning。

### M9 · Wiki 知识库（~1.5 周）

- 范围：目录与 frontmatter 规范、wiki 扩展（构建/增量/衰减复验）、工具三件套、倒排索引 + 可选语义索引、TUI 集成（@ 补全、文件树标记）。
- 验收：中型仓库首建 ≤ 预算；代码变更后增量更新正确；`wiki_search` 命中率指标入 stats。

### M10 · 数据捕捉与分析（~1.5 周；回测执行器后置）

- 范围：事件模型全量埋点（02 §2 表格逐 type）、脱敏、事件流与 metrics.db ETL、`ponda stats` 各子命令（skills/tasks/sessions/permissions/cost）、dataset export（digest/full 两级）；**冻结** BacktestSpec/BacktestReport 接口（07 §7），执行器实现列入 M11+。
- 验收：开启 telemetry 跑一周后，`stats skills` 能给出 success_rate/cost_per_invoke 排名；dataset export 的 full 级脱敏抽检通过。

## 3. 里程碑外的持续事项

- **上游同步**：pi 上游每次 minor 版本执行 rebase 流程（`PATCHES.md` 护栏），冲突在补丁区域内解决；每季度评估上游大重构的合并成本。
- **文档**：每个里程碑随代码更新用户文档（`docs/usage/`，与设计文档分离）。
- **回测执行器（M11+，未排期）**：按冻结接口实现 `ponda backtest run` 与 worktree 隔离重放；随后评估 RL 数据闭环的实需。

## 4. 风险登记表

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | fork 与上游漂移、rebase 冲突成本累积 | 高 | 补丁区域清单 + 护栏测试 + 定期同步节奏（M0 起流程化）；上游大重构时允许跳过个别版本再评估 |
| R2 | TUI 范围蔓延（三栏+弹窗+补全工作量被低估） | 高 | 组件无头快照测试先行；公式/鼠标等列开放问题后置；M5 内部再分两批交付（读视图→交互全集） |
| R3 | SKILL.state 小模型失败模式（状态覆盖/漏合并） | 中 | 整体状态校验 + 领域 schema 示例 + 降级路径（06 §7）；M7 用多模型实测标定 |
| R4 | 容器逃逸 / 运行时漏洞 | 中低 | 依赖 Docker/Podman 隔离强度 + 网络默认 none + 资源上限；overlay 审计兜底；关注运行时安全通告 |
| R5 | daemon 稳定性（孤儿进程/socket 泄漏） | 中 | 事实全落盘、崩溃可重建；空闲自退出 + `ponda daemon stop`；M4 专项混沌测试 |
| R6 | swarm 成本失控 | 中 | 并发与费用双熔断；TUI 实时费用 chip；超限暂停询问 |
| R7 | 软链接在部分文件系统/Windows 不可用 | 低 | linkMode 降级链（junction→copy）；doctor 检测 |
| R8 | telemetry 磁盘与隐私顾虑 | 低 | 默认关闭 + retention + 脱敏审计命令 |
| R9 | 容器运行时不可用（无 Docker 环境 / macOS 性能损耗） | 中 | 降级链（audit-only）+ macOS 性能指引（03 §8）；镜像支持私有 registry 与离线导入 |

## 5. 排期汇总（乐观估计，单人全职当量）

```
M0  1 │ M1  1.5 │ M2  1.5 │ M3  3 │ M4  1.5 │ M5  2 │ M6  2 │ M7  1.5 │ M8  2 │ M9  1.5 │ M10 1.5
累计 ≈ 20 周（M5/M6、M7 部分并行可压至 ~17 周）
```

> 排期为相对量级，用于决策与并行规划；执行前应按投入人力重估。
