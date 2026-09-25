# ponda

[中文](#中文) | [English](#english)

---

## 中文

ponda 是基于 [pi coding agent](https://github.com/earendil-works/pi) 的环境管理与长时任务运行时（本仓库为 pi 的 fork）。

### 功能

- **环境管理**：命名隔离的 agent 环境——每个环境是一个独立的 pi agent dir（system prompt、工具集、skills、MCP servers、extensions、主题等），支持按 DAG 继承（`--base`）；切换环境后 pi 原生连接对应目录。
- **资源池**：skills / tools / prompts / extensions / themes / providers / models / MCP servers 统一存放于 `~/.ponda/resources/`，以软链接注入环境；支持免切换操作（如 `ponda <env> skills list`）。
- **长时任务运行时**：每环境一个常驻 daemon，会话可脱离 TUI 存活；todolist、goal 任务、成果契约与确认、agent swarm。
- **沙箱**：三模式（inplace 快照 / git worktree / 临时工作区），修改可追踪、可回滚、结算需用户确认；容器后端（Docker/Podman），无容器环境降级为审计型沙箱。
- **三栏 TUI**：左栏会话与文件、中栏对话、右栏 todolist（`packages/tui/src/ponda`，不改上游）。
- **上下文管理**：按 SKILL.state 论文（arXiv:2608.26263）实现结构化执行状态。
- **数据捕捉**：脱敏 telemetry 事件流 + SQLite 指标层，RL 数据集导出接口预留。

### 快速开始

要求 Node >= 22（原生 TS 执行）。

```bash
# 1) 构建 monorepo（含上游 pi，约 3-5 分钟；此后可跳过）
npm install --ignore-scripts && npm run build

# 2) 初始化并管理环境
node packages/cli/src/bin.ts init              # default 环境 + shell 集成（--print 预览）
node packages/cli/src/bin.ts env create web-dev --base default
node packages/cli/src/bin.ts env activate web-dev
node packages/cli/src/bin.ts env list

# 3) 以当前环境运行真正的 pi（透传，agent dir = 环境目录）
node packages/cli/src/bin.ts pi --version
node packages/cli/src/bin.ts pi                 # 交互 TUI

# 4) 资源管理 / 免切换操作
node packages/cli/src/bin.ts skills add <本地skill目录> <name>
node packages/cli/src/bin.ts web-dev skills list   # 不切环境直接查

# 5) ponda 自有包测试（node:test，零额外依赖）
for p in core cli sandbox metrics; do (cd packages/$p && node --test test/*.test.ts); done
```

`PONDA_HOME` 环境变量可覆盖 `~/.ponda` 根目录（测试与多实例隔离用）。

其他命令：`doctor`（fork 基线与上游差距）、`sandbox`、`daemon`、`tui`、`goal`、`stats`、`history`、`memory`、`provider` / `model`（交互式配置）。

### ponda 包

| 包 | 说明 |
|---|---|
| `packages/core` | 领域核心：环境、资源、会话 |
| `packages/cli` | ponda CLI（bin: `ponda`） |
| `packages/daemon` | 每环境常驻 agent 进程，后台会话存活 |
| `packages/rpc` | JSON-RPC over Unix domain socket（TUI ↔ daemon） |
| `packages/sandbox` | 沙箱：三域路由、git 快照引擎、临时工作区 |
| `packages/metrics` | 数据捕捉：事件模型、脱敏、JSONL、skill 指标 |
| `packages/tui/src/ponda` | 三栏 TUI（上游包内新增子目录） |

其余为上游 pi 包（`coding-agent`、`agent`、`ai`、`tui`、`durable`、`chord`、`telemetry` 等），除 [PATCHES.md](PATCHES.md) 登记的补丁区域外未做改动。

### 文档与状态

- 设计文档：[docs/design/](docs/design/README.md)（建议从 [00-overview.md](docs/design/00-overview.md) 读起）
- 需求原文：[docs/requirements.md](docs/requirements.md)
- fork 补丁区域登记：[PATCHES.md](PATCHES.md)
- 里程碑与进度：[docs/design/09-roadmap.md](docs/design/09-roadmap.md)。当前：M0–M2 完成，M3/M7/M10 核心完成。

### 与上游的关系

本仓库 fork 自 `earendil-works/pi`（基线见 PATCHES.md），定期 rebase。对上游包的全部改动登记在 PATCHES.md 中并配有护栏测试；清单之外的改动一律以新增包 / 新增文件实现。

### 开发

```bash
npm run check   # lint / format / type check（整个 monorepo）
./test.sh       # 全量测试（含上游 pi，无 API key 时跳过 LLM 相关测试）
```

## License

MIT

---

## English

ponda is an environment management and long-horizon task runtime built on the [pi coding agent](https://github.com/earendil-works/pi) (this repository is a fork of pi).

### Features

- **Environment management**: named, isolated agent environments—each environment is a standalone pi agent dir (system prompt, tool set, skills, MCP servers, extensions, themes, …) with DAG inheritance (`--base`); after switching, pi natively resolves to the corresponding directory.
- **Resource pool**: skills / tools / prompts / extensions / themes / providers / models / MCP servers live once in `~/.ponda/resources/` and are injected into environments via symlinks; cross-environment operations without switching (e.g. `ponda <env> skills list`).
- **Long-horizon task runtime**: one resident daemon per environment keeps sessions alive without the TUI; todolists, goal tasks, deliverable specs with user confirmation, agent swarm.
- **Sandbox**: three modes (inplace snapshot / git worktree / temp workspace) with tracked, revertible changes and user-confirmed settlement; container backend (Docker/Podman) with an audit-only fallback when no container runtime is available.
- **Three-pane TUI**: left pane for sessions and files, center for conversation, right for the todolist (`packages/tui/src/ponda`, no upstream edits).
- **Context management**: structured execution state following the SKILL.state paper (arXiv:2608.26263).
- **Data capture**: scrubbed telemetry event stream + SQLite metrics layer, with a reserved RL dataset export interface.

### Quick Start

Requires Node >= 22 (native TS execution).

```bash
# 1) Build the monorepo (includes upstream pi, ~3-5 min; skippable afterwards)
npm install --ignore-scripts && npm run build

# 2) Initialize and manage environments
node packages/cli/src/bin.ts init              # default env + shell integration (--print to preview)
node packages/cli/src/bin.ts env create web-dev --base default
node packages/cli/src/bin.ts env activate web-dev
node packages/cli/src/bin.ts env list

# 3) Run the real pi with the active environment (pass-through, agent dir = environment dir)
node packages/cli/src/bin.ts pi --version
node packages/cli/src/bin.ts pi                 # interactive TUI

# 4) Resource management / operations without switching
node packages/cli/src/bin.ts skills add <local-skill-dir> <name>
node packages/cli/src/bin.ts web-dev skills list   # query without activating

# 5) Tests for ponda's own packages (node:test, no extra dependencies)
for p in core cli sandbox metrics; do (cd packages/$p && node --test test/*.test.ts); done
```

The `PONDA_HOME` environment variable overrides the `~/.ponda` root (for tests and multi-instance isolation).

Further commands: `doctor` (fork baseline vs. upstream drift), `sandbox`, `daemon`, `tui`, `goal`, `stats`, `history`, `memory`, `provider` / `model` (interactive configuration).

### ponda Packages

| Package | Description |
|---|---|
| `packages/core` | Domain core: environments, resources, sessions |
| `packages/cli` | ponda CLI (bin: `ponda`) |
| `packages/daemon` | Resident per-environment agent process, background session liveness |
| `packages/rpc` | JSON-RPC over Unix domain socket (TUI ↔ daemon) |
| `packages/sandbox` | Sandbox: three-domain routing, git snapshot engine, temp workspaces |
| `packages/metrics` | Data capture: event model, scrubbing, JSONL sink, skill metrics |
| `packages/tui/src/ponda` | Three-pane TUI (new subdirectory inside the upstream package) |

The remaining packages are upstream pi (`coding-agent`, `agent`, `ai`, `tui`, `durable`, `chord`, `telemetry`, …), unmodified except for the patch areas registered in [PATCHES.md](PATCHES.md).

### Docs & Status

- Design docs: [docs/design/](docs/design/README.md) (start with [00-overview.md](docs/design/00-overview.md))
- Original requirements: [docs/requirements.md](docs/requirements.md)
- Fork patch-area registry: [PATCHES.md](PATCHES.md)
- Milestones and progress: [docs/design/09-roadmap.md](docs/design/09-roadmap.md). Current: M0–M2 done, M3/M7/M10 core done.

### Relationship to Upstream

This repository forks `earendil-works/pi` (baseline recorded in PATCHES.md) and rebases periodically. All changes to upstream packages are registered in PATCHES.md with guard tests; anything outside the registry must be implemented as new packages or new files.

### Development

```bash
npm run check   # lint / format / type check (whole monorepo)
./test.sh       # full test suite (includes upstream pi; LLM-dependent tests are skipped without API keys)
```

## License

MIT
