# 00 · 总体架构

> ponda 设计方案 · 总览与基础约定。其余模块文档均遵循本文的概念模型与目录约定。

## 1. 定位与边界

ponda 是 [pi coding agent](https://github.com/earendil-works/pi)（npm: `@earendil-works/pi-coding-agent`，下称 **pi**）的 **fork**：在 pi 的代码基线上直接构建多环境管理与长时任务运行时，同时保持对上游的持续跟进能力：

- **多环境**：每个环境（Environment）拥有独立的 system prompt、工具集、skills、MCP servers、extensions、运行时策略、记忆、快捷键与主题。
- **沙箱隔离**：agent 对文件系统的修改经过可追踪、可回滚的沙箱机制。
- **长时任务运行时**：todolist、goal 模式、成果状态确认、后台会话存活、agent swarm。
- **结构化上下文管理**：参照 SKILL.state（arXiv:2608.26263v3）以显式状态取代历史堆叠。
- **数据捕捉**：为技能质量分析与（预留的）强化学习、回测提供数据地基。

### 1.1 与 pi 的关系（最重要的架构决策）

**ponda 是 pi monorepo 的 fork**（v1.1 决策，替代最初的"外挂编排层"方案）。fork 策略：

- **改动收敛**：按"新增包优先、内核补丁最小化"组织改动。直接触碰上游包（pi-coding-agent / pi-tui / pi-agent-core / pi-ai）的修改收敛到一份**补丁区域清单**（`PATCHES.md`，见 §5），清单外一律以新增代码实现。
- **上游同步**：固定 `upstream` remote，按 pi 发版节奏定期 rebase；每个补丁区域配套护栏测试（上游改动冲突破坏行为时 CI 立即暴露）。`ponda doctor` 报告当前 fork 基线 commit 与落后上游的版本数。
- **形态兼容**：extension API、agent dir、session JSONL 等上游机制全部保留——ponda 运行时能力仍以 extension 形态组织（可独立启停、可单测），只是**允许**在必要时触达内核挂载点（工具执行管线、上下文组装点、TUI 布局），这是选择 fork 的根本收益。

fork 后对上游机制的使用与改造点：

| 上游机制 | ponda 中的用法 / 改造 |
|---|---|
| agent dir（默认 `~/.pi/agent/`）+ `PI_CODING_AGENT_DIR` | **一个 ponda 环境 = 一个 agent dir** 不变；激活改为 `ponda` 入口原生读取 `state.json` 定位（环境变量保留为显式覆盖） |
| `--session-dir` / `PI_CODING_AGENT_SESSION_DIR` | 环境内会话目录独立，swarm 子 agent 会话再细分（不变） |
| `--extension / --skill / --theme / --system-prompt / --tools` 等 CLI 旗标 | 由环境 manifest 渲染出启动参数（不变） |
| extension API（`registerTool` / `registerCommand` / `on(tool_call)` / `on(context)` / `ctx.ui` 等，jiti 免编译加载 TS） | 运行时模块的默认形态；fork 后**新增原生挂载点**（工具执行管线、上下文组装、TUI 布局）供沙箱 / skill-state / 三栏 TUI 深度集成 |
| settings.json / models.json / auth.json / SYSTEM.md / mcp.json | 环境配置的目标格式，由 ponda 生成与托管（不变） |
| pi-ai（统一多 provider LLM API、token/成本追踪） | 直接复用（不变） |
| pi-tui（终端 UI 库：Markdown/代码高亮/图片协议/布局组件） | **直接改造**：在 pi 的 TUI 上实现三栏布局（04），而非另起应用 |
| pi-agent-core（agent 循环） | **直接改造**：daemon 化（05 §5）、上下文组装点植入 skill-state（06） |
| 会话 JSONL（树形条目、分支/fork/resume） | history 管理与回测 replay 的数据源（不变） |
| packages 体系（`npm:` / `git:` / 本地路径） | 资源池安装通道（不变） |

### 1.2 非目标（本期）

- 不实现 RL 训练框架本身，只做数据集导出与评测接入（见 `07-data.md`）。
- 容器沙箱以 Docker/Podman 为后端（03 §2），但不自研容器运行时/镜像格式；无容器环境降级为审计型沙箱。
- 不做多用户/服务端部署，ponda 是单机单用户工具。

## 2. 分层架构

```
┌───────────────────────────────────────────────────────────────┐
│ L4  ponda tui        三栏 TUI（改造 fork 内的 pi TUI）            │
├───────────────────────────────────────────────────────────────┤
│ L3  运行时模块（extension 形态，可触达内核挂载点）：                │
│     sandbox-guard / todolist / goal / status-confirm /         │
│     skill-state / swarm / wiki / telemetry                     │
├───────────────────────────────────────────────────────────────┤
│ L2  ponda cli        ponda env|skills|tools|provider|model|     │
│                      prompt|memory|extension|theme|history|tui │
├───────────────────────────────────────────────────────────────┤
│ L1  ponda core       领域模型：Environment / Resource /          │
│                      SessionIndex / Sandbox / TaskState         │
├───────────────────────────────────────────────────────────────┤
│ L0  pi 基线（fork 自 earendil-works/pi，随上游演进）               │
│     pi-coding-agent / pi-ai / pi-tui / pi-agent-core           │
└───────────────────────────────────────────────────────────────┘
```

- **L0 是 fork 的上游基线**：ponda 对上游包的改动收敛在补丁区域清单内（§1.1/§5），保证 rebase 成本可控。
- **L1 core** 是纯 TypeScript 库，无 UI 依赖，CLI 与 TUI 共用。
- **L3 运行时模块**默认以 extension 形态组织（独立启停、可单测），必要时经内核挂载点直接集成（沙箱入工具执行管线、skill-state 入上下文组装点）。
- **L4 TUI** 直接改造 fork 内的 pi TUI（新增三栏布局组件），与 agent 进程仍分离（agent 以 daemon 形式存活），这是"后台对话存活机制"的进程基础（见 `05-runtime.md` §5）。

## 3. 核心概念模型

```ts
/** 环境：命名隔离的 agent 运行单位，物化为一个 pi agent dir + manifest */
interface Environment {
  name: string;
  manifest: EnvManifest;      // 见 01-environment.md §2
  dir: string;               // ~/.ponda/envs/<name>/（即 pi agent dir）
}

/** 资源：可被环境启用的受管实体，存放于共享资源池 */
type ResourceKind =
  | 'skill' | 'tool' | 'prompt' | 'extension' | 'theme'
  | 'provider' | 'model' | 'mcp-server';

interface Resource {
  kind: ResourceKind;
  name: string;
  version: string;
  source: 'builtin' | 'registry' | 'local';  // 见 02-resources.md §2
  installedAt: string;
}

/** 会话：pi 的 JSONL 会话，归属唯一环境；索引层支持跨环境检索 */
interface SessionRef {
  id: string;
  env: string;
  workspace?: string;        // 会话启动时的工作目录
  status: 'running' | 'detached' | 'ended';
  tokens: { input: number; output: number };
  cost: number;
}

/** 长时任务：goal 模式与 skill-state 的宿主 */
interface Task {
  id: string;
  goal: string;              // 用户设定的目标
  deliverables: DeliverableSpec[];   // 成果清单，见 05-runtime.md §4
  state: SkillStateEnvelope;         // 结构化执行状态，见 06-context.md §3
  todos: TodoItem[];                 // 任务分解，见 05-runtime.md §2
}

/** 沙箱工作区：一次受隔离的修改活动的载体 */
interface SandboxWorkspace {
  id: string;
  kind: 'temp' | 'worktree' | 'inplace';  // 见 03-sandbox.md §3
  backingGit?: string;
  createdAt: string;
}
```

概念间关系：

- `Environment` 启用（enable）若干 `Resource`；启用通过**软链接注入**环境目录实现。
- `Session` 属于一个 `Environment`；`Task` 挂在 `Session` 上。
- `SandboxWorkspace` 由 `Session` 按需创建，生命周期由用户确认点驱动。
- swarm 的每个子 agent 拥有自己的 `Session`（子会话），共享父任务的 `Task.state` 黑板。

## 4. 目录约定

```
~/.ponda/                          # PONDA_HOME（可用 PONDA_HOME 覆盖）
├── ponda.json                     # 全局配置（默认 provider、telemetry 开关等）
├── state.json                     # 全局运行态：当前激活环境等（自动生成）
├── envs/
│   └── <env-name>/                # 一个环境 = 一个 pi agent dir
│       ├── manifest.json          # ponda 环境清单（唯一事实源，见 01 §2）
│       ├── settings.json          # 由 manifest 渲染（pi 消费）
│       ├── SYSTEM.md              # 环境主 system prompt（由 manifest 渲染）
│       ├── APPEND_SYSTEM.md
│       ├── models.json            # provider/model 声明（pi 消费）
│       ├── auth.json              # 环境内凭据（ponda 托管写入）
│       ├── mcp.json               # MCP servers（pi-mcp-adapter 消费）
│       ├── keybindings.json
│       ├── skills/                # 软链接（池内共享）+ 私有目录
│       ├── extensions/
│       ├── themes/
│       ├── prompts/
│       ├── memory/                # 环境记忆（见 02 §7）
│       └── sessions/              # 该环境的 pi 会话 JSONL
├── resources/                     # 共享资源池
│   ├── skills/<name>/
│   ├── tools/<name>/
│   ├── prompts/<name>/
│   ├── extensions/<name>/
│   ├── themes/<name>/
│   ├── models/<name>.json         # 可共享的 provider/model 定义
│   └── <kind>s/<name>/resource.json   # 资源元数据
├── sandboxes/                     # 工作区外操作的临时工作区（见 03 §4）
│   └── <sandbox-id>/
├── daemon/                        # ponda-agent daemon 的 pid/socket/log（见 05 §5）
├── telemetry/                     # 数据捕捉（见 07-data.md）
│   ├── events/<YYYY-MM-DD>.jsonl
│   └── metrics.db                 # SQLite 指标库
└── wiki-cache/                    # 各工作区 .wiki 的索引缓存（见 08-wiki.md）

<workspace>/                       # 用户工作区（项目目录）
├── .ponda/
│   ├── ponda.json                 # 工作区级环境绑定与策略（见 01 §7）
│   ├── worktrees/                 # 该工作区的 git worktree（见 03 §5）
│   ├── state/<task-id>.json       # skill-state 状态快照（见 06 §5）
│   └── verify/<task-id>/          # 成果校准脚本（见 05 §4）
└── .wiki/                         # 工作区知识库（见 08-wiki.md）
```

要点：

- **manifest.json 是唯一事实源**：`settings.json` / `SYSTEM.md` / `models.json` / `mcp.json` 全部由 manifest **渲染生成**，禁止手改（手改会在下次渲染时被覆盖；`ponda env doctor` 可检测漂移）。
- 环境目录内 skills/extensions/themes/prompts 同时容纳**软链接**（指向 `~/.ponda/resources/`，跨环境共享、更新即生效）与**私有实体**（仅本环境可见）。
- 工作区内的 `.ponda/` 应加入用户 `.gitignore`（`ponda env activate` 首次检测时提示）。

## 5. Monorepo 结构

**ponda 仓库 = pi monorepo 的 fork**（npm workspaces，Node ≥ 22，TypeScript，ESM）。上游包（`pi-ai` / `pi-tui` / `pi-agent-core` / `pi-coding-agent` 等）原样保留，ponda 新增包与之并列，对上游包的修改收敛为补丁区域：

```
ponda/                            # fork 自 earendil-works/pi
├── PATCHES.md                    # 【补丁区域清单】对上游包的全部改动索引 + 护栏测试映射
├── packages/
│   ├── ai/  tui/  agent/  coding-agent/ ...   # 上游包（改动仅限 PATCHES.md 登记区域）
│   ├── core/                     # L1：领域模型与纯逻辑
│   │   └── src/{env,resource,session,sandbox,task,telemetry,upstream-sync}/
│   ├── cli/                      # L2：ponda 命令（bin: ponda，含 `ponda pi` 透传原生命令）
│   │   └── src/commands/{env,skills,tools,provider,model,prompt,memory,
│   │              extension,theme,history,tui,goal,init}.ts
│   ├── sandbox/                  # git/worktree/路径重定向/容器后端（core 的伴生库）
│   ├── telemetry/                # 事件采集、脱敏、SQLite 指标
│   └── protocol/                 # TUI ↔ daemon ↔ 运行时模块的 RPC 协议与类型
└── extensions/                   # L3：运行时模块（jiti 加载 .ts，extension 形态）
    ├── ponda-core-ext/           # 常驻：环境标识、telemetry、权限事件总线
    ├── sandbox-guard/            # 沙箱（依赖 packages/sandbox 与内核挂载点）
    ├── todolist/
    ├── goal/
    ├── status-confirm/
    ├── skill-state/
    ├── swarm/
    └── wiki/
```

依赖规则：`extensions/* → packages/{core,sandbox,telemetry,protocol}`；`packages/cli → packages/core`；**对上游包的修改只出现在 `PATCHES.md` 登记的区域内**（入口读 state.json、TUI 三栏布局、上下文组装点、daemon 化支持四处，随实施增补），`packages/core/src/upstream-sync/` 维护清单本身与 rebase 辅助脚本（冲突检测、护栏测试索引）。

## 6. 关键数据流

### 6.1 环境激活 → pi 启动

```
用户: ponda env activate web-dev
  └─ core: 校验 envs/web-dev 存在 → 渲染 manifest → envs/web-dev/{settings.json,...}
  └─ core: 写 state.json { activeEnv: "web-dev" }
  └─ shell 集成（01 §6）: 读 state.json 更新提示符 (pi:web-dev)
       （兼容：仍可 export PI_CODING_AGENT_DIR 供外部脚本消费）
用户: ponda（即 fork 后的 pi 入口；`ponda pi` 透传原生命令）
  └─ 入口原生读 state.json 定位 agent dir → 加载该环境的 SYSTEM.md 与声明的 extensions/skills/themes
       └─ ponda 运行时模块在进程内生效（沙箱、todo、telemetry...）
```

### 6.2 TUI / 后台存活

```
ponda tui
  └─ 启动/复用 ponda-agent daemon（每环境一个，见 05 §5）
       └─ daemon 以 pi-agent-core 驱动会话循环，会话持续落盘 JSONL
  └─ TUI 通过 protocol 包的 RPC 订阅事件流（消息、todo、成果状态、权限请求）
       └─ 用户切换会话 = TUI 侧 detach；daemon 中任务不中断
       └─ 任务完成 → daemon 通知（终端 bell / 系统通知）
```

### 6.3 数据捕捉

```
agent 进程内 ponda 运行时模块 → on(tool_call/tool_result/message_end/state_patch) 钩子
  └─ telemetry 包：脱敏 → ~/.ponda/telemetry/events/<date>.jsonl
  └─ 异步 ETL → metrics.db（会话/技能/成本指标）
  └─ （预留）数据集导出器 → RL 轨迹格式（07-data.md §5）
```

## 7. 技术选型汇总

| 关注点 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | TypeScript / Node ≥ 22 / ESM | 与 pi 同栈，直接复用其生态；extension 经 jiti 免编译加载 |
| CLI 框架 | 自研轻量 parser（或 commander） | 子命令结构简单稳定，重点在交互式向导 |
| TUI | pi-tui（fork 内直接改造） | 三栏布局并入其渲染循环，视觉与上游一致；已含 Markdown/语法高亮/图片协议/同步渲染 |
| LLM 接入 | pi-ai | 统一多 provider、token/成本追踪 |
| agent 循环 | pi-agent-core（fork 内） | daemon 化与上下文组装点植入在补丁区域内完成，不重写循环 |
| 沙箱约束 | Docker / Podman（后端抽象层） | 每会话容器 + overlayfs 审计；无容器运行时降级审计型（03 §2） |
| 数据存储 | JSONL（事件/会话）+ SQLite（指标，better-sqlite3） | 追加友好、可 grep；SQLite 供分析查询 |
| schema 校验 | TypeBox | 与 pi 工具 schema 一致，一份定义两用（校验 + 模型工具描述） |
| 进程通信 | Unix domain socket + JSON-RPC（protocol 包） | 本机低延迟；TUI 崩溃不带走 agent |

## 8. 横切关注点

- **错误处理**：所有 CLI 命令遵循统一退出码（0 成功 / 1 一般错误 / 2 环境或资源不存在 / 3 校验失败 / 4 被用户拒绝）；TUI 内错误走通知区。
- **并发**：同一环境的 manifest 修改用文件锁（`~/.ponda/envs/<name>/.lock`）串行化；daemon 与 CLI 对 state.json 的写入原子（临时文件 + rename）。
- **安全**：凭据只存 env 目录 `auth.json`（权限 0600），支持 `!command` 从系统密钥管理器取；telemetry 默认关闭，开启即脱敏（07 §4）。
- **可观测**：`ponda doctor` 检查目录完整性、软链接断链、manifest 与渲染产物漂移、pi 版本兼容性。
- **上游同步**：fork 基线落后上游超过 2 个 minor 版本时 `ponda doctor` 警告；rebase 流程与护栏见 `PATCHES.md` 与 `packages/core/src/upstream-sync/`。

## 9. 开放问题

| # | 问题 | 归属文档 |
|---|---|---|
| Q1 | fork 与上游的同步节奏、rebase 冲突处理流程与护栏测试覆盖 | 00 §5 / 09 §3 |
| Q2 | 环境数量增长后资源池的命名空间是否需要 scope（owner/registry 前缀） | 02 |
| Q3 | swarm 子 agent 的费用上限与熔断策略细节 | 05 |
| Q4 | 数学公式在终端的渲染方案（Unicode 近似 vs 六增量预渲染） | 04 |
| Q5 | SKILL.state 对无固定 schema 任务的降级判据量化 | 06 |
| Q6 | 回测重放中工具副作用的隔离级别 | 07 |
