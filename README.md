# ponda

[English](#english) | [中文](#中文)

---

## English

ponda is an environment management and long-horizon task runtime built on the [pi coding agent](https://github.com/earendil-works/pi) (this repository is a fork of pi).

### Features

- **Environment management**: named, isolated agent environments—each environment is a standalone pi agent dir (system prompt, tool set, skills, MCP servers, extensions, themes, …) with DAG inheritance (`--base`); after switching, pi natively resolves to the corresponding directory.
- **Real agent runtime**: each session runs a genuine pi agent loop inside a per-environment daemon, with the coding tool set (read / bash / edit / write), todo/swarm/memory agent tools, and MCP server tools injected into the tool surface. Credentials never land in manifests: plaintext API keys are stored in `env/<name>/auth.json` (0600), while `models.json` only carries `$ENV_VAR` / `!command` references.
- **Headless mode**: `ponda run -p "<prompt>"` drives a session non-interactively (comparable to `claude -p`), with `--json` output, `--new-session`, `--mode`, and `--timeout`.
- **Long-horizon task runtime**: sessions survive without the TUI (detach/attach); todolists, goal tasks with deliverable specs and user confirmation, calibrated verification scripts, and agent swarm. Task/todo/envelope state is persisted and survives daemon restarts; `ponda goal resume` continues from the snapshot.
- **Sandbox**: three modes (inplace snapshot / git worktree / temp workspace). Every agent turn with changes is snapshotted to `ponda/snapshots/<session>` (`auto: turn <n>`); settlement commits use the `ponda(<task|session>): summary` convention and always require explicit confirmation. `ponda sandbox rollback` and the TUI `/undo` command restore any snapshot or the baseline.
- **MCP**: `ponda mcp add <name> --command …` declares stdio MCP servers per environment; the daemon loads `mcp.json` at startup and exposes their tools as `mcp__<server>__<tool>`. Failing servers degrade gracefully.
- **Three-pane TUI** (`ponda tui`): opencode-style focused conversation with a round input box; session/file sidebar; right pane with todolist progress, deliverable status, and permission notices; a status line under the input (mode / thinking level / model / context usage, warning at 80%); collapsed tool calls (`▸ bash … (✔ 0.3s)` with >5 aggregation); slash commands (`/help`, `/new`, `/end`, `/mode`, `/undo`, `/goal`, `/sessions`, `/wiki-rebuild`); `^x p` cycles permission modes, `^x ctrl+t` cycles thinking level.
- **Context management**: structured execution state following the SKILL.state paper (arXiv:2608.26263) under a strict protocol—each step sends only `(P, Σ_t, O_t)` (history stripped, transcript stays constant across turns), invalid patches trigger rollback-retry (≤3) with graceful degradation.
- **Data capture**: telemetry is off by default; when enabled, all 18 event types are emitted (session/message/tool/task/deliverable/permission/swarm/state-patch/container/…) into a scrubbed JSONL event stream, ETL'd into a SQLite metrics layer (`metrics.db`: sessions / tasks / skill_stats / permission_stats / cost_daily). `ponda stats` surfaces sessions, cost, tasks, permissions (approval rates), and skills, plus `rebuild` / `prune` / `audit`.
- **RL dataset export**: `ponda dataset export` with digest (default) and full levels, RewardSignals and EnvSnapshotRef (content-hash of the manifest) so trajectories are attributable to an exact configuration. Backtest interfaces are frozen (`core/src/backtest.ts`); the executor is deferred.

### Quick Start

Requires Node >= 22 (native TS execution).

```bash
# 1) Build the monorepo (includes upstream pi, ~3-5 min; skippable afterwards)
npm install --ignore-scripts && npm run build

# 2) Initialize and manage environments
node packages/cli/src/bin.ts init              # default env + shell integration (--print to preview)
node packages/cli/src/bin.ts env create web-dev --base default \
  --skill <name> --tool 'deploy=./d.sh $ARGUMENTS' --privilege read,execute
node packages/cli/src/bin.ts env activate web-dev
node packages/cli/src/bin.ts env list

# 3) Configure a model (pick one)
export PONDA_MODEL=anthropic/claude-sonnet-4-5          # builtin catalog id
node packages/cli/src/bin.ts provider add               # interactive wizard; plaintext keys -> auth.json (0600)

# 4) Chat / run
node packages/cli/src/bin.ts tui                # interactive TUI (/help for commands & keys)
node packages/cli/src/bin.ts run -p "explain this repo" --json   # headless single turn

# 5) Per-environment MCP servers
node packages/cli/src/bin.ts mcp add fs-server --command npx --args "-y,@modelcontextprotocol/server-filesystem,/tmp"

# 6) Resource management / operations without switching
node packages/cli/src/bin.ts skills add <local-skill-dir> <name>
node packages/cli/src/bin.ts web-dev skills list   # query without activating

# 7) Tests for ponda's own packages (node:test, no extra dependencies)
for p in core cli daemon rpc sandbox metrics tui-next; do (cd packages/$p && node --test test/*.test.ts); done
```

The `PONDA_HOME` environment variable overrides the `~/.ponda` root (for tests and multi-instance isolation).

Further commands: `doctor` (health check, credential migration, render drift), `sandbox` (`list` / `settle` / `commit` / `snapshots` / `rollback` / `clean` / `backend`), `daemon` (`start|stop|status`), `goal` (`start` / `ls` / `status` / `confirm` / `verify` / `settle` / `cancel` / `resume`), `todo ls`, `stats`, `history` (`attach` restores a session under its own environment), `memory`, `provider` / `model`.

### ponda Packages

| Package | Description |
|---|---|
| `packages/core` | Domain core: environments, resources, auth store, sessions, skill-state, backtest interfaces |
| `packages/cli` | ponda CLI (bin: `ponda`) |
| `packages/daemon` | Resident per-environment agent process: real pi loop, tool guard, MCP client, snapshot tracker, telemetry |
| `packages/rpc` | JSON-RPC over Unix domain socket (TUI ↔ daemon) |
| `packages/sandbox` | Sandbox: three-domain routing, git snapshot engine, temp workspaces, container backend |
| `packages/metrics` | Data capture: event model, scrubbing, JSONL sink, SQLite metrics.db, ETL |
| `packages/tui-next` | Three-pane TUI (custom @ponda/tui runtime; `packages/tui/src/ponda` is a legacy M5 implementation, unused) |

The remaining packages are upstream pi (`coding-agent`, `agent`, `ai`, `tui`, `durable`, `chord`, `telemetry`, …), unmodified except for the patch areas registered in [PATCHES.md](PATCHES.md).

### Docs & Status

- Design docs: [docs/design/](docs/design/README.md) (start with [00-overview.md](docs/design/00-overview.md))
- Completeness audit & competitive parity report (vs. Claude Code / OpenCode / gemini-cli): [docs/audit/2026-09-25-completeness-audit.md](docs/audit/2026-09-25-completeness-audit.md)
- Original requirements: [docs/requirements.md](docs/requirements.md)
- Fork patch-area registry: [PATCHES.md](PATCHES.md)
- Milestones and progress: [docs/design/09-roadmap.md](docs/design/09-roadmap.md)

### Relationship to Upstream

This repository forks `earendil-works/pi` (baseline recorded in PATCHES.md) and rebases periodically. All changes to upstream packages are registered in PATCHES.md with guard tests; anything outside the registry must be implemented as new packages or new files.

### Development

```bash
npm run check   # lint / format / type check (whole monorepo)
./test.sh       # full test suite (includes upstream pi; LLM-dependent tests are skipped without API keys)
```

## License

MIT

---

## 中文

ponda 是基于 [pi coding agent](https://github.com/earendil-works/pi) 的环境管理与长时任务运行时（本仓库为 pi 的 fork）。

### 功能

- **环境管理**：命名隔离的 agent 环境——每个环境是一个独立的 pi agent dir（system prompt、工具集、skills、MCP servers、extensions、主题等），支持按 DAG 继承（`--base`）；切换环境后 pi 原生连接对应目录。
- **真实 agent 运行时**：每环境常驻 daemon，会话内跑真实 pi 循环——coding 工具（read/bash/edit/write）、todo/swarm/memory agent 工具与 MCP server 工具注入工具面。凭据不落 manifest：明文密钥存 `env/<name>/auth.json`（0600），models.json 只保留 `$ENV_VAR` / `!command` 引用。
- **headless 模式**：`ponda run -p "<prompt>"` 非交互驱动会话（对标 `claude -p`），支持 `--json` / `--new-session` / `--mode` / `--timeout`。
- **长时任务运行时**：会话脱离 TUI 存活（detach/attach）；todolist、goal 任务（成果契约+用户确认+校准脚本）、agent swarm。任务/看板/状态快照持久化，daemon 重启不丢；`ponda goal resume` 从快照恢复。
- **沙箱**：三模式（inplace 快照 / git worktree / 临时工作区）。每个有变更的轮次自动快照到 `ponda/snapshots/<session>`（`auto: turn <n>`）；结算以 `ponda(<task|session>): 摘要` 规范提交且必须显式确认；`ponda sandbox rollback` 与 TUI `/undo` 可回到任一快照或 baseline。
- **MCP**：`ponda mcp add <name> --command …` 按环境声明 stdio MCP servers，daemon 启动时加载 mcp.json 并以 `mcp__<server>__<tool>` 注入工具面；失败 server 优雅降级。
- **三栏 TUI**（`ponda tui`）：opencode 式聚焦对话 + 圆角输入框；会话/文件侧栏；右栏（todolist 进度 / 成果状态 / 权限通知）；输入区状态行（模式/思考强度/模型/上下文占用，超 80% 警示）；工具调用折叠（`▸ bash … (✔ 0.3s)`，>5 条聚合）；斜杠命令（`/help` `/new` `/end` `/mode` `/undo` `/goal` `/sessions` `/wiki-rebuild`）；`^x p` 循环权限模式、`^x ctrl+t` 循环思考强度。
- **上下文管理**：按 SKILL.state 论文（arXiv:2608.26263）的严格协议——每步只发 `(P, Σ_t, O_t)`（历史剥离、transcript 恒定），无效补丁 rollback-retry（≤3）后优雅降级。
- **数据捕捉**：telemetry 默认关闭；开启后 18 类事件全量埋点进脱敏 JSONL 事件流，ETL 入 SQLite 指标层 `metrics.db`（sessions / tasks / skill_stats / permission_stats / cost_daily 五表）。`ponda stats` 呈现 sessions/cost/tasks/permissions（批准率）/skills，另有 `rebuild` / `prune` / `audit`。
- **RL 数据集导出**：`ponda dataset export` digest（默认）/ full 两级；RewardSignals 与 EnvSnapshotRef（manifest 内容哈希）保证轨迹可归因到确切配置；Backtest 接口已冻结（`core/src/backtest.ts`），执行器后置。

### 快速开始

要求 Node >= 22（原生 TS 执行）。

```bash
# 1) 构建 monorepo（含上游 pi，约 3-5 分钟；此后可跳过）
npm install --ignore-scripts && npm run build

# 2) 初始化并管理环境
node packages/cli/src/bin.ts init              # default 环境 + shell 集成（--print 预览）
node packages/cli/src/bin.ts env create web-dev --base default \
  --skill <name> --tool 'deploy=./d.sh $ARGUMENTS' --privilege read,execute
node packages/cli/src/bin.ts env activate web-dev
node packages/cli/src/bin.ts env list

# 3) 配置模型（三选一）
export PONDA_MODEL=anthropic/claude-sonnet-4-5          # 内置目录 id
node packages/cli/src/bin.ts provider add               # 交互向导；明文密钥 -> auth.json（0600）

# 4) 对话 / 运行
node packages/cli/src/bin.ts tui                # 交互 TUI（/help 查看命令与键位）
node packages/cli/src/bin.ts run -p "解释这个仓库" --json  # headless 单轮

# 5) 按环境声明 MCP server
node packages/cli/src/bin.ts mcp add fs-server --command npx --args "-y,@modelcontextprotocol/server-filesystem,/tmp"

# 6) 资源管理 / 免切换操作
node packages/cli/src/bin.ts skills add <本地skill目录> <name>
node packages/cli/src/bin.ts web-dev skills list   # 不切环境直接查

# 7) ponda 自有包测试（node:test，零额外依赖）
for p in core cli daemon rpc sandbox metrics tui-next; do (cd packages/$p && node --test test/*.test.ts); done
```

`PONDA_HOME` 环境变量可覆盖 `~/.ponda` 根目录（测试与多实例隔离用）。

其他命令：`doctor`（体检/凭据迁移/渲染漂移）、`sandbox`（`list`/`settle`/`commit`/`snapshots`/`rollback`/`clean`/`backend`）、`daemon`（`start|stop|status`）、`goal`（`start`/`ls`/`status`/`confirm`/`verify`/`settle`/`cancel`/`resume`）、`todo ls`、`stats`、`history`（`attach` 以所属环境恢复会话）、`memory`、`provider` / `model`。

### ponda 包

| 包 | 说明 |
|---|---|
| `packages/core` | 领域核心：环境、资源、凭据存储、会话、skill-state、回测接口 |
| `packages/cli` | ponda CLI（bin: `ponda`） |
| `packages/daemon` | 每环境常驻 agent 进程：真实 pi 循环、工具守卫、MCP 客户端、快照链、telemetry |
| `packages/rpc` | JSON-RPC over Unix domain socket（TUI ↔ daemon） |
| `packages/sandbox` | 沙箱：三域路由、git 快照引擎、临时工作区、容器后端 |
| `packages/metrics` | 数据捕捉：事件模型、脱敏、JSONL、SQLite metrics.db、ETL |
| `packages/tui-next` | 三栏 TUI（自研 @ponda/tui 运行时；`packages/tui/src/ponda` 为 M5 旧实现遗留，不在使用） |

其余为上游 pi 包（`coding-agent`、`agent`、`ai`、`tui`、`durable`、`chord`、`telemetry` 等），除 [PATCHES.md](PATCHES.md) 登记的补丁区域外未做改动。

### 文档与状态

- 设计文档：[docs/design/](docs/design/README.md)（建议从 [00-overview.md](docs/design/00-overview.md) 读起）
- 完备度审计与竞品对标报告（vs. Claude Code / OpenCode / gemini-cli）：[docs/audit/2026-09-25-completeness-audit.md](docs/audit/2026-09-25-completeness-audit.md)
- 需求原文：[docs/requirements.md](docs/requirements.md)
- fork 补丁区域登记：[PATCHES.md](PATCHES.md)
- 里程碑与进度：[docs/design/09-roadmap.md](docs/design/09-roadmap.md)

### 与上游的关系

本仓库 fork 自 `earendil-works/pi`（基线见 PATCHES.md），定期 rebase。对上游包的全部改动登记在 PATCHES.md 中并配有护栏测试；清单之外的改动一律以新增包 / 新增文件实现。

### 开发

```bash
npm run check   # lint / format / type check（整个 monorepo）
./test.sh       # 全量测试（含上游 pi，无 API key 时跳过 LLM 相关测试）
```

## License

MIT
