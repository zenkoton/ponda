# ponda 完备度审计与竞品对标差距报告（2026-09-25）

两部分：
1. 设计方案逐项核对汇总（6 个审计线：01 环境 / 02 资源 / 03 沙箱 / 04 TUI / 05 运行时+06 上下文 / 07 数据+08 wiki）
2. 产品经理对标报告（Claude Code / OpenCode / gemini-cli 等主流 TUI agent 基线）

结论先行：**各模块纯逻辑引擎普遍完整且有测试，但大量引擎未接线到生产链路**；最严重的问题是 daemon 会话默认运行在回声假 agent 上（`EchoAgentLoop`），真实 `PiAgentLoop` 从未接入生产且 `tools: []`——TUI/goal/swarm/沙箱/权限全部挂在假链路上。roadmap（09 §5）自述的多个 ✅ 与实际完备度存在明显差距。

---

## 一、总体差距画像（按层）

| 层 | 已实现且接线 | 已实现未接线（引擎存在、无生产调用方） | 完全缺失 |
|---|---|---|---|
| L1 环境/资源 CLI | manifest/合并/渲染/state.json/入口定位；池+软链+五类资源命令；provider 向导；免切换语法 | —— | mcp-server 类别；env create 旗标面；工作区 autoCreate/sandbox/wiki.enabled |
| L3 沙箱 | （CLI 手动路径）tempws settle/clean；backend 探测 | routeWrite/analyzeBash/快照链/容器后端/overlay 审计/降级链 —— **全部无生产调用方**；sandbox-guard 扩展为空壳 | L1 工具拦截接线；bash 容器内执行；SandboxActivity 状态机；结算管线；rollback 命令 |
| L3 运行时 | daemon 进程模型/RPC 全量/attach 游标/权限往返管道；goal 状态机；swarm 调度+熔断+信箱 | todo（无持久化）；bindToolGuard/bindSkillState | **真实 agent 循环接入生产**；todo/任务/envelope 持久化；goal resume；spawn_subagent 等模型工具面；会话文件锁 |
| L4 TUI | 信号/布局/差分/键位底座；对话流/侧栏/文件树/标签页；四类弹窗；快照测试 | —— | 输入区状态行；工具调用折叠；右栏 TODOLIST/权限段；会话操作（d/f//）；弹窗队列；尺寸自适应 |
| 数据 | 事件模型/脱敏/JSONL sink；stats sessions/cost | aggregateSkillStats（无调用方）；wiki 倒排索引（无缓存） | metrics.db 整体；16/18 事件埋点；BacktestSpec 接口冻结；dataset full 级 |
| wiki | 目录/frontmatter/构建/增量/衰减逻辑；wiki 工具三件套（RPC） | 触发链（wiki.enabled/结算后增量/空闲复验） | 系统提示注入；语义索引；api/ 页类型 |

---

## 二、设计逐项审计：关键缺口 TOP（按影响排序，跨模块合并）

### P0（可用性阻断 / 安全）

1. **daemon 无真实 agent 循环**：`main.ts` 不传 `piModel` → 全部会话回落 `EchoAgentLoop`；`PiAgentLoop` 即使接上也是 `tools: []`（pi-loop.ts:69）。TUI 首次对话即假 agent 且无任何提示。
2. **provider 凭据明文落盘**：无 auth.json / 0600，apiKey 明文写入 manifest.json 并渲染进 env/models.json（render.ts:139-141）。设计 02 §6.1 明确要求凭据单独存 `env/auth.json` 0600。
3. **bindToolGuard 返回形状与上游不符**：返回 `{action:"block"}`/`{action:"continue"}`，上游 `BeforeToolCallResult` 只认 `{block,reason,terminate}`（agent-loop.ts:739）——即使接上守卫也是空操作；且入参改写不被上游支持（需原地改写 args 引用）。
4. **skill-state 历史未剥离**：`processWithSkillState` 保留全部旧消息仍发给模型（pi-loop.ts:119-124），违反 06 号设计第一公理"每步只发 (P, Σ_t, O_t)"；rollback-retry ≤3 与降级链整链缺失（pi-loop.ts:129-131 `void parsed.errors`）。
5. **telemetry 默认开启**：daemon/telemetry.ts:57-61 默认 true，与 07 §1"默认 false"及 roadmap R8 隐私缓解相反。

### P1（设计核心闭环断裂）

6. **沙箱全部引擎未接线**：L1 拦截层整体缺失（sandbox-guard 空壳）；ensureGit/snapshot/SessionContainerManager/settleAudit 生产零调用；turn_end 快照、rollback 命令、SandboxActivity 状态机、结算管线不存在；权限三档模式（plan/approve/full-auto）无任何运行时分支；env-always 批准不写回 manifest。
7. **RuntimePolicy 无会话级消费**：backgroundLiveness/contextStrategy/permissionMode/skillStateDomain 在 daemon/TUI/CLI 零消费者；`env activate` 不触发 daemon 懒启动。
8. **任务/看板/envelope 全内存态**：无 `.ponda/state/<taskId>.json` 快照，daemon 重启全丢；goal resume 入口缺失；违背 05 §5.1"Task/Todo/Deliverable 快照落 .ponda/"与 §5.2 崩溃恢复语义。
9. **swarm 无模型工具面**：spawn_subagent/send_message/swarm_status 均为 RPC 而非 agent 可调用工具；SubagentSpec 缺 model/skills；read-only 模式不设防；子 envelope 不并入父 Σ。
10. **todolist 两端皆缺**：无系统提示注入、无 `ponda todo ls` CLI、TUI 右栏是占位符；todo 无持久化。
11. **mcp-server 类别整体断掉**：无 CLI 命令组、enable 抛错、pi fork 无 MCP 客户端消费 mcp.json。
12. **command tool / memory 运行时链路缺失**：ponda-core-ext 扩展不存在，manifest tools.custom 无人注册为工具；无 memory_write 工具，MEMORY.md 不并入 APPEND_SYSTEM.md。
13. **metrics.db 指标层整体缺失** + **16/18 事件类型零埋点**（仅 message/session.start 两点且 payload 不符设计）。
14. **history 与设计不符**：attach 只打印指引不恢复、只收全 ID（界面显示 8 位前缀，复制即失败）；rm 不进 .trash；无 --status/树形分支/ripgrep；索引每次全量扫描非派生增量。
15. **TUI 深度欠账**：输入区状态行（mode/思考强度/模型/上下文占用）、工具调用-结果折叠（解析层丢弃 tool 条目）、右栏 TODOLIST+权限段、会话操作（Enter attach/d/f//过滤）、弹窗队列（单槽覆盖）、尺寸自适应、文件超链接、tui.json 偏好。
16. **wiki 触发链全未接线**：wiki.enabled 零读取、结算后不增量、衰减复验无空闲补跑；系统提示"优先 wiki_search"未注入；检索无持久索引缓存；文件树反而排除 .wiki。

### P2（边界与体验）

17. env create 旗标面收窄（--template/--tool/--skill 等缺失）+ 交互向导缺失；`env freeze` ESM 下 `require` 必崩且无测试；渲染无 .staging 整体 swap；default 环境缺 ponda-core-ext。
18. chpwd/pin 语义反转：bind 一律静默覆盖全局激活并持久化（设计：提示不覆盖，除非 pin:true）；Ctrl-P 快捷键只有注释；`_hook` 无 mtime 缓存。
19. 资源安全长效机制：registry add 无确认提示（--yes）、digest 只写不校验、无 prune 版本保留、无 linkMode 降级。
20. 校准细节：verify 缺 test 型、verify.json 缺 cwd/超时/env 白名单、校准脚本不受沙箱约束、无最终报告、无"超出契约"检测。
21. dataset export 结构缩水（无 RewardSignals/action/EnvSnapshotRef 哈希/full 级）；BacktestSpec 接口未冻结。
22. CLI 易用性：主帮助不列新命令组；子命令 --help 在未 init 时报"环境不存在"；错误打全栈；`init --print` 有副作用。

（各模块逐条 file:line 明细见 2026-09-25 审计会话的六份审计线原始输出；本文件为合并去重后的缺口清单。）

---

## 三、PM 对标报告（Claude Code / OpenCode / gemini-cli）

### 竞品来源
- Claude Code：commands（60+ 斜杠命令）、permission-modes（5 档）、headless `-p`、checkpointing/rewind、subagents。https://code.claude.com/docs/en/commands 等
- OpenCode：默认输入焦点 + Esc 导航 + leader 键范式、session 管理、build/plan 双 agent、/undo /share、LSP。https://opencode.ai/docs/
- gemini-cli：session 自动保存恢复、/rewind + checkpointing、plan-mode、git-worktrees、themes、headless。https://github.com/google-gemini/gemini-cli/tree/main/docs/cli

### 功能差距（竞品有、ponda 无/弱）

| 能力 | ponda 现状 | 优先级 |
|---|---|---|
| 真实 agent 循环（读/写/执行工具） | 无（daemon=echo，pi-loop tools:[]） | **P0** |
| 斜杠命令真实执行 | 仅补全候选，发送后成模型回声 | **P0** |
| 权限模式切换（plan/auto + 快捷键） | 类型存在，无运行时分支、无 TUI 切换 | **P0** |
| 会话恢复 resume | JSONL 落盘但 attach 不恢复、前缀不匹配 | **P0** |
| MCP 消费方 | 渲染 mcp.json 但无客户端 | P1 |
| /compact 上下文压缩（普通会话） | 仅 goal 任务绑定 skill-state | P1 |
| headless 非交互模式（对标 claude -p） | 无 | P1 |
| 撤销 / 回滚入口 | sandbox 引擎存在但未接 TUI/工具链 | P1 |
| 模型自主 spawn 子代理 | swarm 运行时就绪，无模型工具 | P1 |
| TUI 内模型/思考强度切换 | 无（thinkingLevel 硬编码 off） | P1 |
| 主题切换（TUI 内）/图片/公式/代码高亮 | 无/无/无/仅 dim | P2 |
| LSP 集成 | 无 | P2 |
| cost/usage 展示 | 有（数据源接真循环后即真实） | 达标 |

### 易用性问题（新用户首走旅程）

1. 首次对话即假 agent 且无提示（P0）。
2. 主帮助不列 sandbox/daemon/tui/goal/stats/dataset/wiki；`tui --help` 等在未 init 时报"环境不存在：default"（P0）。
3. 冷启动错误不一致：tui 报环境不存在（无补救提示）、pi 提示先 init（对）、skills list 静默空表（P1）。
4. `init --print` 仍创建 default 环境（P1）。
5. shell 集成快捷键只有注释示例，`ponda-env-list` widget 不存在；"下一步"话术误导（P1）。
6. `history attach` 8 位前缀复制即失败 + 只打印指令不执行（P0）。
7. 用户级错误打全栈（P1）。
8. 文档漂移：README 指 tui 旧目录（死代码）；roadmap 验收含 `ponda todo ls` 但命令不存在（P1）。
9. TUI 无帮助屏/键位面板（P2）。
10. 无会话新建/重命名/结束命令（P2）。
11. `skills --help` 输出"未知动作：。"——帮助走错误路径兜底（P2）。

### 对标结论

ponda 的环境/资源管理 CLI 达到可用水准，但全部差异化能力（三栏 TUI、daemon 后台会话、goal 契约、swarm、沙箱）目前挂在一条回声假链路上。距离"对标主流 TUI agent"的差距不是功能数量，而是**真实 agent 运行时这一层没有接通**。

---

## 四、修复排期建议（本轮从 P0-1 开始）

| 批次 | 内容 |
|---|---|
| 批次 1（P0） | daemon 按会话接入真实 PiAgentLoop + coding 工具（read/bash/edit/write）；修 bindToolGuard 形状 + 原地改写；接 sandbox 三域路由与权限申请；权限三档模式；TUI 斜杠命令；history attach；telemetry 默认关；--help 优先 |
| 批次 2 | todo/任务/envelope 持久化 + `ponda todo ls`；skill-state 历史剥离 + retry；goal resume；模型工具面（spawn_subagent 等） |
| 批次 3 | 凭据 auth.json 隔离；沙箱结算管线与 rollback 命令；TUI 状态行/工具折叠/右栏；metrics.db + 埋点补齐 |
| 批次 4 | P2 清单（env create 旗标面、linkMode、prune、LSP、主题、图片/公式等） |

## 五、修复进度（2026-09-25 批次 1，已落地）

| 缺口 | 状态 | 落点 |
|---|---|---|
| daemon 无真实 agent 循环 | ✅ 已修 | `daemon/src/main.ts`（PONDA_MODEL > ponda.json.model > env models.json 三级解析，每会话独立 PiAgentLoop + createCodingTools）；未配置时回声循环首条回复明示演示模式 |
| bindToolGuard 返回形状不符 | ✅ 已修 | `daemon/src/pi-loop.ts`（block/reason 对齐上游 BeforeToolCallResult；改写经原地合并 args 生效） |
| 沙箱 L1 拦截整体缺失 | ✅ 核心 | `daemon/src/tool-guard.ts`（write/edit 三域路由：deny 拒绝 / temp-workspace 副本重写 / inplace 放行；bash 高危名单申请；策略从 manifest+工作区解析） |
| 权限三档模式零实现 | ✅ 核心 | tool-guard plan/approve/full-auto 行为 + RPC `session.set_mode` + daemon 会话级模式 |
| TUI 斜杠命令是装饰 | ✅ 已修 | `tui-next/src/app/app.ts` runSlashCommand：/help /new /mode /sessions /goal /wiki-rebuild 真实执行；补全列表与实现一一对应；完整输入命令 Enter 直接发送（不再被补全吞掉） |
| history attach 断裂 | ✅ 已修 | 短 id 前缀解析（歧义报错）+ `--switch-env` + 经 `pi --session <file>` 以所属环境真实恢复 |
| telemetry 默认开启 | ✅ 已修 | `daemon/src/telemetry.ts` 默认 false（07 §1） |
| env freeze ESM 崩溃 | ✅ 已修 | 移除 `require("node:fs")` |
| 子命令 --help 冷启动报错 | ✅ 已修 | bin.ts 任意子命令 --help/-h 先于环境检查打印帮助；主帮助补全命令组与模型解析说明 |
| `ponda todo ls` 缺失 | ✅ 已修 | RPC `todo.list` + CLI todo 组 |
| init --print 副作用 | ✅ 已修 | --print 不再创建 default 环境 |
| CLI 错误打全栈 | ✅ 已修 | 单行错误信息；PONDA_DEBUG=1 附栈 |
| permission/tool 埋点缺失（部分） | ✅ 部分 | permission.request/decision、tool.call/tool.result 经 tool-guard/telemetry 落事件 |

验证：daemon 39/39、cli 37/37、core 56/56、tui-next 28/28、rpc 7/7、sandbox 18/18、metrics 4/4 测试绿；`npm run check` 全绿；daemon 启动消息含模型解析来源（env-var/global-config/env-models 或"未配置，演示回声模式"）。

### 六、批次 2（2026-09-26，P1 核心闭环）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| provider 凭据明文落盘（安全） | ✅ 已修 | `core/src/auth.ts`（auth.json 0600、$ENV/!command 引用解析）；render 剥离明文进 credentials→auth.json；池 installProviderDef 剥明文留引用；CLI provider add/向导明文→auth.json；doctor 自动迁移旧 manifest；daemon getApiKey 优先级 auth.json > 引用 > 旧明文兼容 |
| todo/任务/envelope 全内存态 | ✅ 已修 | `daemon/src/persist.ts` + TaskRuntime/TodoRuntime 写穿 `envs/<env>/state/{tasks,todos}/`，daemon 重启恢复；有工作区任务 envelope 双写 `<ws>/.ponda/state/<taskId>.json`（06 §3） |
| goal resume 缺失 | ✅ 已修 | TaskRuntime.resume（相位守卫）+ RPC `task.resume` + CLI `ponda goal resume <id>` |
| skill-state 历史未剥离（06 第一公理） | ✅ 已修 | pi-loop `stripToProtocolOnly`：每步 prompt 恒为 [system(P+工具声明), user(Σ,O)]，跨步不增长（测试断言恒定 3 条） |
| rollback-retry ≤3 + 降级 | ✅ 已修 | 无效补丁注入纠错消息重试 ≤3；超限降级完整历史 + onDegraded 通知（06 §3/§7）；SkillStateBinding 增 applyPatch/onDegraded |
| swarm/todo/memory 无模型工具面 | ✅ 已修 | `daemon/src/agent-tools.ts`：todo_write/todo_read、spawn_subagent/swarm_status/send_message/cancel_subagent、memory_write 经闭包直连运行时；系统提示注入分解纪律与 swarm 用法 |

验证：daemon 56、cli 38、core 61 测试绿；`npm run check` 全绿。

### 七、批次 3-1（2026-09-26，数据层）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| metrics.db 指标层整体缺失 | ✅ 已修 | `metrics/src/db.ts`（node:sqlite WAL，sessions/tasks/skill_stats/permission_stats/cost_daily 五表 + etl_cursor，全 UPSERT 幂等） |
| ETL 游标幂等 | ✅ 已修 | `metrics/src/etl.ts`：事件流按文件游标增量消费；`rebuild --from` 重放指定日期之后；daemon 优雅退出自动同步（core.shutdown→syncMetrics） |
| 事件埋点 16/18 缺失 | ✅ 已修 | daemon：message（tokens/costUsd）、session.end（ended/daemon-shutdown）、task.lifecycle、deliverable.verify、permission.request+decision（带 privilege）、swarm.cell（状态迁移+费用）、state.patch/compaction（skill-state 协议）、container.lifecycle（容器/audit-only）、error（会话错误+全局未处理异常）、skill.invoke（skill:* 工具）；CLI：env.switch、resource.change、sandbox.settle（`cli/src/telemetry-cli.ts`，同一开关/脱敏通道） |
| stats 子命令面不全 | ✅ 已修 | `stats rebuild [--from] / prune / audit` 新增；sessions/cost 切换指标层（无 db 回退 JSONL 扫描）；tasks/permissions 新增（批准率——07 §5"据此调整权限策略"）；skills 读 skill_stats |

验证：metrics 7、daemon 58、cli 39、core 61 测试绿；`npm run check` 全绿。

### 八、批次 3-2（2026-09-26，TUI 深度项）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| 输入区状态行（04 §5.4） | ✅ 已修 | 输入框下方一行：mode/思考强度/模型/上下文占用（ctx 12k/200k（6%）），超 80% 黄色警示 "/compact"；数据源 daemon 事实（session.list 带 mode、新 RPC session.info 返回 runtimeInfo、session.set_thinking）；^x p 与导航 p 循环切换权限模式（plan→approve→full-auto） |
| 工具调用-结果对折叠（04 §5.3） | ✅ 已修 | PiAgentLoop 订阅 tool_execution_start/end → 会话流落 `ponda.tool` 条目（attach 重放可见）→ TUI 渲染 `▸ tool args（✔/✘ 0.3s）`（失败红色）；连续同类 >5 条聚合为 `▸ 6× edit` |
| 右栏三段（04 §4.3） | ✅ 已修 | RightPanel = TODOLIST 段（▓/░ 进度条 + done/total + ◐ 进行中 + 条目；todo.events 通知实时刷新）+ 成果状态段（原 GoalPanel）+ 权限/通知段（待确认弹窗计数） |
| piModel 路径共享 loop 串会话上下文 | ✅ 顺带修复 | DaemonCore 对 piModel 也合成按会话 loopFor（含 coding 工具与工具事件落盘） |

验证：cli 44、daemon 58、tui-next 28、metrics 7、core 61 测试绿；`npm run check` 全绿。

### 九、批次 3-3（2026-09-26，沙箱结算管线）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| turn_end 快照链未接线 | ✅ 已修 | PiAgentLoop onTurnEnd → InplaceSandboxTracker.snapshotTurn：每轮有变更（含未跟踪）向 `ponda/snapshots/<session8>` 提交 `ponda: auto: turn <n>`；同内容轮去重（快照链=真实状态跃迁）；首写 ensureGit + baseline 记录 |
| SandboxActivity 状态机 | ✅ 已修 | pending→dirty→snapped→committed/rolledback→closed；落 `envs/<env>/state/sandbox-activities.json`（daemon 重启恢复） |
| 结算 commit 规范 | ✅ 已修 | `ponda sandbox commit <摘要> [--task]`：变更清单→TTY y/N 确认→`ponda(<task8|session8>): <摘要>` + body（turns/快照区间）；非 TTY 拒绝 exit 4（03 §6.3 无旁路） |
| rollback 命令缺失 | ✅ 已修 | `ponda sandbox rollback <turn> | --baseline`（确认后 reset --hard）；`ponda sandbox snapshots [前缀]` 查看快照链 |
| TUI 内撤销入口（PM 对标项） | ✅ 已修 | TUI `/undo`：sandbox.status 查快照链→确认弹窗（复用 merge 弹窗）→ RPC sandbox.rollback 回上一快照/baseline；e2e 验证修改→快照→/undo→Enter→内容回滚且快照链保留 |

验证：cli 46、daemon 60、sandbox 18 测试绿；`npm run check` 全绿。

### 十、批次 4-1（2026-09-26，headless）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| headless 非交互模式（PM P1，对标 claude -p） | ✅ 已修 | `ponda run -p "<prompt>"`：ensureDaemon → 续用最近 live 会话（--new-session 强制新建）→ session.send → 轮询 processing=false → 读会话尾部 assistant 输出；支持 --env/--json（sessionId/text/usage 负载）/--mode/--timeout；复用 daemon 真实链路（工具链/沙箱守卫/快照链）；`-p` 单横线别名对齐 claude 习惯 |

验证：cli 48、daemon 60 测试绿；`npm run check` 全绿。

### 十一、批次 4-2/4-3（2026-09-26，差距清单收官）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| MCP 客户端（PM P1"渲染 mcp.json 但无客户端"） | ✅ 已修 | `daemon/src/mcp.ts`：stdio ndjson JSON-RPC（initialize→tools/list→tools/call），server 工具包装为 `mcp__<server>__<tool>` 注入 PiAgentLoop 工具面（daemon start 加载 / shutdown 停止 / 失败 server 降级不阻塞）；e2e 用 fixture MCP server 验证真实调用入会话流 |
| mcp-server 资源类别 | ✅ 已修 | `ponda mcp list/add/rm/info`（写 manifest.mcp → 渲染 mcp.json；免切换语法覆盖；子环境继承=01 §3 并集，产物按 env 目录物理隔离） |
| env create 旗标面（01 §4.1） | ✅ 已修 | --tool name=command、--privilege r,w,e（非法 exit 3）、--skill/--extension/--theme（池校验并入 create patch，与 --no-render 正交） |
| wiki 触发链（08 §3.1 增量） | ✅ 已修 | `ponda sandbox commit` 结算成功后 .wiki 存在则 refreshWiki（按 git diff scope 复验，basedOn 前移）；测试验证 |
| BacktestSpec/Report 冻结（07 §7） | ✅ 已修 | `core/src/backtest.ts`：六口径 BacktestMetricId + 定义表 + Spec/Report 类型（执行器仍 M11+ 后置，符合"接口先行冻结"） |
| dataset full 级（07 §6） | ✅ 已修 | `--level full --yes`（二次确认，缺 --yes exit 4）：含观察全文；RewardSignals 冻结字段 + EnvSnapshotRef（manifest SHA256）补齐 |

验证：cli 54、daemon 63、core 61、metrics 7、sandbox 18、tui-next 28 测试全绿；`npm run check` 全绿（含补绑的 ^x ctrl+t 思考强度循环键，PM P1 #5 完整闭环）。

### 十二、批次 4-4（2026-09-26，P2 收尾）已落地

| 缺口 | 状态 | 落点 |
|---|---|---|
| Ctrl-P 快捷键名存实亡（审计 §二-6 / PM 易用性 #5） | ✅ 已修 | 集成脚本三 shell 真实绑定：zsh `zle -N` widget + `bindkey '^Pe/^Pc/^Pi/^Pd'`；bash `bind -x '"\C-pe"'…`（READLINE_LINE 预填）；fish `bind \cpe…`（commandline 预填）；e=列表+激活预填 c=创建 i=信息 d=删除预填；zsh -n / bash -n 语法验证通过 |
| TUI 会话结束命令（PM 易用性 #10） | ✅ 已修 | TUI `/end`：RPC `session.end` → 会话转只读 ended（重命名受 pi 会话数据模型限制后置，title 由首条用户消息派生） |
| 代码块高亮（PM 差距 #12，04 §5.2 标"后续"的一级方案） | ✅ 一级 | markdown fence 语言标签行（`── ts ──`）+ 代码块主题色板（codeBlock dim）；完整语法高亮随 tui-next 主题系统后置 |
| 文档漂移（PM 易用性 #8） | ✅ 已修 | README 四处 `packages/tui/src/ponda` 旧目录引用改为 `packages/tui-next`（旧目录标注遗留不在用）；README/PONDA.md 测试命令补齐 daemon/rpc/tui-next |

验证：cli 55、daemon 63、tui-next 28 测试绿；`npm run check` 全绿。

**批次 1-4 差距清单至此全部闭环**：PM 报告的 P0/P1/P2 对标必备项（真实 agent 循环、斜杠命令、权限模式、会话恢复、headless、MCP、撤销入口、TUI 深度项）与设计审计的关键缺口（凭据隔离、持久化+resume、skill-state 严格协议、模型工具面、metrics.db+埋点、沙箱结算管线）均已实现并带测试。剩余为设计中的显式后置项（回测执行器 M11+、RL 训练框架、语义索引、容器内 bash 执行、research/refactor 领域 schema 等——见 07/08/03 号设计与 roadmap）。
