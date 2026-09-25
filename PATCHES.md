# PATCHES.md — 补丁区域清单

本仓库是 [earendil-works/pi](https://github.com/earendil-works/pi)（`upstream` remote）的 fork。本文件登记对**上游包**的全部改动区域；清单外的改动必须以新增包 / 新增文件实现。

规则（见 `docs/design/00-overview.md` §1.1 / §5）：

1. 新增包优先：能用 `packages/core`、`packages/cli` 等新包实现的能力，不修改上游文件。
2. 每个补丁区域必须登记：涉及文件、目的、护栏测试（防止上游 rebase 时冲突静默丢失）。
3. 定期 rebase upstream；冲突只在本清单登记的文件内解决。
4. `ponda doctor` 报告当前 fork 基线与上游差距。

## 登记表

| # | 区域 | 上游文件 | 目的 | 状态 | 护栏测试 |
|---|---|---|---|---|---|
| P1 | 入口环境定位 | `packages/coding-agent/src/config.ts`（getAgentDir/getPondaAgentDir） | 启动时读 `~/.ponda/state.json` 原生定位 agent dir（`PI_CODING_AGENT_DIR` 保留为显式覆盖；坏 state/目录缺失静默回落默认） | **已落地** | `packages/cli/test/pi-entry.test.ts`（4 护栏 + 真 pi `--list-models` e2e） |
| P2 | TUI 三栏布局 | 无（已迁移：原 `packages/tui/src/ponda/**` 补丁区整体撤销，上游 `packages/tui` 零改动） | 三栏布局（左会话/文件、中对话、右 todo）改由新包 `packages/tui-next`（`@ponda/tui`）实现：opencode TUI 范式（solid 风格信号 + 声明式组件 + flexbox + cell buffer 行差分 + 分层 keymap），不再依赖 pi-tui | **已落地（`packages/tui-next`，M5）** | `packages/tui-next/test/*.test.ts`（框架 28 项）+ `packages/cli/test/tui*.test.ts`（5 文件：无头渲染断言/差分证据/交互 e2e） |
| P3 | 上下文组装点 | `packages/agent/src/**` | skill-state 的 `(P, Σ, O)` 原生重写挂载点 | 计划中（M7） | `extensions/skill-state/test` |
| P4 | daemon 化支持 / 真 agent loop | `packages/daemon/src/pi-loop.ts`（新增） | 会话循环可脱离 TUI 进程存活（daemon）；session.send 经 pi-agent-core Agent 真实循环驱动 | **已落地（faux provider 测试链路；真实 provider 配置面待环境 models.json 完整接入）** | `packages/daemon/test/pi-loop.test.ts`（2 e2e） |

## 当前状态

- 基线：`earendil-works/pi@5fd446c`（2026-09-25 fork）
- 已应用补丁：**P1 已落地**（getAgentDir 原生解析 ponda state；`ponda pi` 包装同步简化为仅透传）。**P2 已迁移至新包 `packages/tui-next`**（opencode TUI 范式自研运行时，原 `packages/tui/src/ponda/**` 补丁区撤销，上游 `packages/tui` 无改动）。P3/P4 详见登记表。
- 命名避让：设计文档 00 §5 的 `packages/telemetry`、`packages/protocol` 与上游包同名，ponda 实现分别落在 `packages/metrics`（数据捕捉）与 `packages/rpc`（TUI↔daemon 协议）；另新增 `packages/daemon`（M4）与 `packages/tui-next`（M5 TUI，目录名避开上游 `packages/tui`）。上游 `packages/telemetry`/`packages/protocol`/`packages/tui` 目录未做任何改动。
