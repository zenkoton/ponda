# 08 · Wiki 知识库（`.wiki/`）

> readme："在工作区区间，agent 可以自动构建 wiki 知识库，用来加速文件检索和知识管理，目录存放在 .wiki 目录下"。

## 1. 模块目标与定位

- **给 agent 的检索加速层**：把代码库的结构性知识（模块图、约定、决策、术语）固化为可增量更新的紧凑文档，使 agent 用少量 token 定位代码而非全库扫描。
- **给人看的项目脑图**：`.wiki/` 是普通 markdown，人类可直接阅读编辑（编辑后的变更会在下次更新时被尊重，见 §4.3）。
- 与 `.ponda/`（运行数据）分离：wiki 属于**项目资产**，建议提交 git（由 `ponda.json` 决定）；`.wiki-cache`（索引缓存）在 `~/.ponda/` 下，不进项目。

## 2. 目录结构与条目格式

```
<workspace>/.wiki/
├── index.md                 # 总览：项目一句话、模块导航、最近更新
├── modules/                 # 按模块/目录的知识页
│   └── auth.md
├── decisions/               # ADR：架构与技术决策（含来自 agent 任务的 decisions 状态）
│   └── 0001-session-storage.md
├── glossary.md              # 术语表（领域词汇 → 定义 → 相关代码位置）
├── conventions.md           # 代码约定（从 AGENTS.md/lint 配置提炼）
└── api/                     # 可选：对外接口摘要
    └── rest.md
```

条目 frontmatter（机器可维护的元数据）：

```yaml
---
title: auth 模块
kind: module            # module | decision | glossary | convention | api
scope: src/auth/        # 覆盖的路径前缀（可多个）
updatedAt: 2026-09-25T10:00:00Z
basedOn: git:<commit>   # 生成依据的 commit
confidence: 0.9         # 自上次代码变更后未经复验的衰减置信度
---
```

正文要求：≤ 200 行/页、每个事实附代码位置引用（`src/auth/session.ts:42`）、避免重复代码原文。

## 3. 生成与更新机制（wiki 扩展）

### 3.1 触发

| 触发 | 时机 | 动作 |
|---|---|---|
| 首次构建 | workspace 无 `.wiki/` 且 `ponda.json#wiki.enabled`（或用户 `/wiki-build`） | 全量构建（走一次受限的 agent 任务：仅 read/grep 工具 + token 预算） |
| 增量更新 | 任务结算后（03 §6.2 apply 提交时）/ 用户 `/wiki-rebuild [scope]` | 按 git diff 触及的 `scope` 找到受影响页面复验更新 |
| 衰减复验 | `confidence` 随触及该 scope 的未复验提交数衰减（每提交 −0.2），低于 0.4 的页面列入待复验队列，空闲时（daemon 空闲策略同 07 §4 ETL）补跑 | 重写该页 |

### 3.2 构建任务的约束

- 工具白名单：read/grep/glob/wiki 自身工具；**无写权限于工作区**（只写 `.wiki/`，经 sandbox-guard 特批路径）。
- token 预算：全量构建默认 200k tokens 上限、增量 20k，超限即止并标记未完成页。
- 模型：可用廉价模型（构建任务的 DeliverableSpec 即"页面清单"，复用 05 §4 的校准机制：页面存在性/行数/引用路径有效性作为 verify）。

### 3.3 agent 侧工具（wiki 扩展注册）

| 工具 | 语义 |
|---|---|
| `wiki_search(query)` | 关键词 + 局部语义检索（§5），返回页面摘要 + 代码位置引用 |
| `wiki_read(page)` | 读整页 |
| `wiki_update(page, content)` | 增量维护（agent 在任务中获知新事实时写入；走 confidence 重置） |

系统提示注入（启用 wiki 的环境）："优先 wiki_search 再 grep 全库"。

## 4. 与其他模块的联动

- **skill-state（06）**：领域 schema 的 `facts` 可声明来源 `wiki:<page>`，任务启动时把相关页摘要并入 Σ 的知识初值——wiki 成为"规程 P 的领域知识段"。
- **todolist/goal（05）**：长任务收尾报告建议附带 `wiki_update`（把 decisions 写入 `.wiki/decisions/`），形成知识沉淀闭环。
- **telemetry（07）**：`wiki_search` 命中率与"命中后是否减少 grep 调用"作为 wiki 有效性指标（`ponda stats wiki`）。
- **TUI（04）**：`@` 补全包含 `.wiki/` 页面；左栏文件树 wiki 页带 📄 标。

## 5. 检索加速实现

- **倒排索引**：`~/.ponda/wiki-cache/<workspace-hash>/inverted.json`（标题/标题权重、正文分词、代码标识符），wiki 页变更时增量重建。
- **语义索引（可选组件）**：本地 embedding（ONNX 运行时 + 小型嵌入模型，首次下载需确认；无此组件时只有关键词检索，功能可降级）。
- 查询流程：关键词召回（必须）→ 语义重排（若有）→ 返回 top-k 摘要；索引缺失时现场 grep `.wiki/`（慢路径兜底）。

## 6. 边界情况与开放问题

- **人类编辑冲突**：页面含 `hand-edited: true` 标记（检测：非 wiki 扩展的写入）后，agent 更新采取**追加小节**而非重写，并在页面顶提示复核。
- **大型 monorepo**：`.wiki/` 按 scope 分片，单页限额防止膨胀；超大型仓库（>5 万文件）首建时间与成本的实测值待 M9 标定，必要时提供 `--shallow`（只建 index + glossary）。
- **敏感信息**：构建任务读全库，`.wiki` 若提交 git 需经脱敏检查（密钥形状检测同 07 §3）。
- **OQ**：跨项目 wiki 复用（环境级 wiki，如"团队规范库"挂到某环境而非 workspace）——接口上预留 `kind: shared` 页面来源，语义待用户反馈。
