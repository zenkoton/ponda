# 03 · 沙箱与隔离

> 目标：agent 的一切文件修改**可追踪、可回滚、需确认**；工作区外的文件不被直接触碰；原文件永不被自动删除。隔离机制 = **容器（强制隔离 + overlay 审计，v1.1 决策）** + git（追踪/回滚）+ worktree（并行工作区）+ 临时工作区（工作区外保护）。

## 1. 模块目标与需求映射

| readme 需求 | 本文章节 |
|---|---|
| agent 不直接访问系统资源，系统调用与文件操作在沙箱中进行 | §2 / §7 |
| （用户决策 v1.1）容器化加强沙箱强制隔离与审计 | §2 / §2.1 |
| 工作区外单/多文件操作 → 自动创建临时工作区并拷贝文件，原文件不被自动删除 | §4 |
| 工作区内操作 → 检查 git 配置文件，没有则自动创建，修改可追踪可回滚 | §5.1 |
| 隔离通过 worktree + git 配置文件实现 | §5 |
| 用户确认后提交 commit；git log 查看、git checkout 回滚 | §6 |
| 合并操作需用户手动确认 | §6.3 |
| TUI 的权限申请弹窗（数据来源） | §7 |

## 2. 威胁模型与实现层次

ponda 沙箱 = **容器强制隔离 + 路径重定向 + 双通道审计 + 确认点**（v1.1 起容器为默认形态）：

| 层 | 机制 | 防护 |
|---|---|---|
| L1 拦截 | sandbox-guard 挂工具执行管线（fork 内原生挂载点，形态仍为 extension），改写/拒绝工具入参 | 所有经工具管的文件与命令操作 |
| L2 重定向 | 路径重写：工作区外写 → 临时工作区；worktree 模式 → worktree 内 | 意外损坏真实文件 |
| L3 容器约束 | bash 执行与写操作运行在**每会话容器**内：namespace/cgroup 隔离、网络出口策略、CPU/内存/磁盘上限 | bash 任意代码被 confined——文件系统视野=挂载清单，网络=策略白名单，资源=限额 |
| L4 审计（双通道） | ① **overlayfs 上层 diff**：容器内全部写动作物化为 overlay 上层目录的文件级证据（覆盖 git 忽略的路径）② git snapshot/commit 链 | 事后回滚与完整审计 |
| L5 确认 | 权限申请流程（§7）+ 合并/结算确认（§6.3） | 未经授权的破坏性动作 |

### 2.1 容器后端

```ts
interface ContainerBackend {
  id: 'docker' | 'podman';
  run(spec: ContainerSpec): Promise<ContainerHandle>;   // 生命周期由 daemon 托管，随会话销毁
}
interface ContainerSpec {
  image: string;                 // 默认 ponda/sandbox:minimal（node+git+常用工具），环境可定制
  binds: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[];
  network: 'none' | 'egress-policy';    // 默认 none；环境声明域名级白名单
  limits: { cpus: number; memoryMb: number; diskMb: number };
  overlayUpperDir: string;       // 审计通道① 的取证据路径
}
```

- **挂载清单按 §3 三域推导**：工作区（inplace：rw）/ worktree（rw，仅该 worktree）/ 临时工作区（rw）；工作区外路径一律**不挂载**——容器内不可见即不可写，比路径重写更强的保证（重写仍保留，用于 L1 一致性与降级态）。
- **审计闭环**：结算（§6.2）时读取 overlay 上层目录生成写证据，与 git 快照交叉比对——只出现在 overlay 的写入（如 .gitignore 掉的路径）单独列出，堵住"绕过 git 追踪"的口子。
- **降级链**：检测不到 Docker/Podman → 退回 L1+L2+L4(git)+L5 的审计型沙箱，会话标记 `confinement: audit-only` 并显著提示；无容器时高危命令名单（§7.1）收紧为**默认拒绝**。

明确不防：容器运行时自身逃逸（依赖 Docker/Podman 的隔离强度，与业界容器威胁模型一致）、用户已批准权限内的逻辑性破坏（靠确认点与双通道审计兜底）。

## 3. 三种操作域与策略

会话启动时确定 `workspace`（pi 进程 cwd 所在的工作区根：含 `.ponda/`、`.git/` 或 cwd 本身）。此后每次写操作按目标路径路由：

```
目标路径 ∈ workspace
  ├─ sandbox.mode = 'inplace'   → 模式 A：工作区内直改 + git 快照（默认，小改流畅）
  └─ sandbox.mode = 'worktree'  → 模式 B：git worktree 隔离（大范围/试验性修改）
目标路径 ∉ workspace
  └─ outsideWorkspace = 'temp-workspace' → 模式 C：临时工作区（拷贝进、确认后写回）
      outsideWorkspace = 'deny'          → 拒绝并引导（提示需授权）
```

策略来源与优先级：工具调用级声明 > 任务级（goal 任务的 sandbox 覆盖）> 工作区 `.ponda/ponda.json` > 环境 manifest `privileges.sandbox`（01 §2.1）。

## 4. 模式 C：临时工作区（工作区外文件）

readme 原文场景："针对单一文件或多个文件进行修改、不在文件夹（工作区）下操作时，系统自动创建一个临时工作区，拷贝文件，在其中操作，确保原文件不会被自动删除"。

### 4.1 流程

```
1. agent 请求写 /etc/nginx/nginx.conf（工作区外）
2. sandbox-guard：路由到模式 C → 创建 ~/.ponda/sandboxes/<sandbox-id>/
   sandbox-id = <sessionShortId>-<seq>
3. 拷贝目标文件（保持相对结构）：
   sandboxes/<id>/etc/nginx/nginx.conf  ←  拷贝自原路径（原文件只读不动）
   同时写入 sandbox.json（记录映射：{ virtualPath → realPath }、创建时间、来源工具调用）
4. 挂载与路径重写：临时工作区以 rw bind-mount 进入会话容器、原路径不挂载（容器内不可见）；
   agent 的读写均指向容器内副本路径（保证 agent 看到自己的修改），并注入提示：
   "你正在临时工作区修改 <path> 的副本，写回需用户确认"
5. agent 完成修改（沙箱内 git init + 自动快照，同模式 A 的追踪机制）
6. 结算（§6.2）：生成对原文件的 diff → 用户确认 →
   a) apply：备份原文件为 <path>.ponda-bak-<ts>（永不自动删除）→ 写回 → 记录成功
   b) discard：保留沙箱 7 天（.trash 语义）供找回
```

### 4.2 规则

- 拷贝是**按需**的：一次任务触碰多少个工作区外文件就拷多少；`sandbox.json` 登记全部映射，会话结束统一结算。
- 新文件（原路径不存在）同样进沙箱；apply 时在真实位置创建（父目录不存在则询问）。
- 同一 sandbox 内多文件修改**一起结算**，避免半应用状态；确认界面按文件列出 diff 摘要，允许逐文件勾选。

## 5. 模式 A/B：工作区内操作

### 5.1 前置：git 保障（两种模式共用）

进入会话并发生首个写操作时：

- workspace 有 `.git` → 记录 HEAD 为基线（`baseline`），确保"干净起点"（有未提交改动则提示用户先提交或 stash，或选择在快照分支上工作）。
- 无 `.git` 且 `autoGitInit = true` → 自动 `git init` + 初始 commit（含全部现有文件；.gitignore 追加 `.ponda/`、`.wiki/` 视配置）——即 readme 的"自动创建一个 git 配置文件，确保所有修改可被追踪和回滚"。
- `autoGitInit = false` → 询问用户（CLI 一次性确认 / TUI 弹窗）；拒绝则该会话降级为只读+提示。

### 5.2 模式 A：inplace + 快照链

- agent 直接改工作区文件（路径不重写），但 sandbox-guard 在**每个 agent 轮次结束**（`turn_end` 钩子）检查 `git status`，有变更则向快照分支 `ponda/snapshots/<sessionShortId>` 提交 `auto: turn <n>`。
- 快照分支基于 baseline 创建，工作区当前分支只被用户（或结算流程）推进——快照提交用 `git stash create` + `git branch -f` 技巧避免切换分支。
- 效果：任意轮次可 `ponda sandbox rollback <turn>` 精确恢复；`git log ponda/snapshots/...` 审计每一步。

### 5.3 模式 B：worktree 隔离

readme："worktree 是一个独立的工作区"。适用：大重构、试验性修改、多子 agent 并行（swarm 默认用 worktree，见 05 §6）。

```
1. git worktree add .ponda/worktrees/<wt-id> -b ponda/wt/<wt-id> <baseline>
2. sandbox-guard 把会话全部读写路径前缀重写： <workspace>/ → <workspace>/.ponda/worktrees/<wt-id>/
   （bash 工具的 cwd 一并重写；容器挂载清单同步收窄为仅该 worktree）
3. agent 在 worktree 内完成修改（内部同样跑快照链）
4. 结算 = 合并回主分支：diff 预览 → 用户手动确认（readme："合并操作需要提示用户手动进行确认"）
   → 优先 fast-forward / rebase 到原分支 → 冲突时提供三方合并界面提示（交给用户在编辑器解决，
      ponda 不自动解决冲突）→ 成功后 git worktree remove
```

- worktree 元数据（wt-id、分支、创建它的任务/子 agent）写入 `.ponda/worktrees/index.json`。
- 会话异常退出遗留的 worktree：`ponda sandbox clean [--dry-run]` 列出并清理（有未合并修改的先打包进 .trash）。

## 6. 追踪、提交与回滚时序

### 6.1 状态机

```
修改活动（SandboxActivity）
  pending ──agent 修改中──▶ dirty ──轮次快照──▶ snapped
                            │                      │
                            └──── 结算请求 ────────┤
                                                   ▼
        apply（用户确认）──▶ committed ──▶ closed
        discard（用户确认）──▶ rolledback ──▶ closed
```

### 6.2 结算（用户确认点）

触发：任务/会话收尾、goal 任务完成比对后、用户主动 `ponda sandbox settle`。TUI 内为合并确认弹窗；CLI 直启 pi 时为终端内 y/n/逐文件选择。

确认内容展示：变更文件清单（新增/修改/删除计数）、聚合 diffstat、逐文件 diff 可展开、来源（哪个任务/轮次）。证据源双通道交叉：git 快照链 与 容器 overlay 上层 diff（§2.1）比对，仅出现在 overlay 的写入（git 忽略路径等）单独列出。

**提交语义（readme："用户确认之后，agent 会将修改提交到 git 配置文件中，并生成一个新的 commit"）**：

- 用户确认 apply → 以规范 message 提交到工作区当前分支（模式 A），或合并 worktree 分支（模式 B）：
  `ponda(<task|session>): <一句话摘要>` + body 记录环境、任务 id、快照区间、校准结果。
- 回滚：`ponda sandbox rollback` 交互选择回到某个快照/baseline（内部 `git checkout`/`reset --hard` 到快照引用，工作分支指向恢复点）；同时支持用户直接 `git log` / `git checkout` 手工操作——ponda 的快照就是普通 git 对象，不锁死用户。

### 6.3 合并的强制确认

所有"沙箱/worktree 内容进入用户分支"的动作（apply、merge、worktree 结算）**必须**经用户显式确认，无 `--yes` 旁路（full-auto 权限模式也不豁免合并确认，仅豁免轮次内写操作，见 §7.3）。

## 7. 挂载与集成：sandbox-guard（fork 内原生挂载点，extension 形态）

### 7.1 拦截点

| 挂载点（fork 内） | 用途 |
|---|---|
| `tool_call`（write/edit） | 解析 `path` 入参 → 三域路由与路径重写；返回修改后的入参或抛权限申请 |
| `tool_call`（bash） | 在会话容器内执行（§2.1；降级态才直接本机执行）；命令静态分析：提取涉及路径（`~` 展开、相对路径拼接）、高危模式名单（`rm -rf`、`git push --force`、磁盘/网络管理命令等）触发权限申请；cwd 重写（worktree） |
| `tool_call`（read/glob/grep） | 读路径在 temp-workspace 有映射时重定向到副本；工作区外的读默认放行（可按环境收紧为 `read` 权限） |
| `turn_end` | 模式 A 快照提交 |
| `session_shutdown` | 未结算活动提醒/自动进入待结算清单 |

### 7.2 权限模型

```ts
interface PermissionRequest {
  id: string;
  sessionId: string;
  privilege: 'read' | 'write' | 'execute';
  reason: string;              // sandbox-guard 生成的说明
  detail: { tool: string; targetPath?: string; command?: string; mode: 'C'|'B'|'危险命令' };
  scope: 'once' | 'session' | 'env-always';
}
```

- 请求经 protocol 包的事件总线发给 TUI（弹窗）/ CLI（行内确认）；扩展超时（默认 120s）视为拒绝。
- 环境基线 `privileges.privileges` 预授；`env-always` 的批准写回 manifest（`ponda provider info` 式可审计）。

### 7.3 权限模式（与 TUI 的"计划/批准/全自动"对应）

| 模式 | 行为 |
|---|---|
| plan | 一切写/执行均需确认；agent 先出计划 |
| approve | 工作区内写预授（快照兜底），工作区外/高危命令/合并仍需确认 |
| full-auto | 工作区内写与执行预授；合并与 `env-always` 级越权仍需确认 |

模式是**会话级**状态（默认取环境 `runtime.permissionMode`），TUI 输入区可切换（05 §1 / 04 §5.4）。

## 8. 边界情况与开放问题

- **非 git 可用的机器**：模式 B/C 依赖 git；git 缺失时 C 退化为"纯副本 + 手工 diff"（无快照链，提示风险），B 不可用。
- **容器可用性**：CI/无 Docker 环境走降级链（§2.1）；镜像默认拉取公共 registry，可配置私有 registry 与离线导入（`ponda sandbox image import`）。
- **macOS 注意**：Docker Desktop 的 bind-mount 性能与文件事件语义有差异，文档标注推荐 Linux/Podman；rw 挂载尽量限定在工作区/worktree。
- **符号链接逃逸**：路径重写前解析 realpath，防止 workspace 内软链指向区外被误判为区内。
- **巨型文件拷贝**：模式 C 拷贝上限（默认 100MB/文件）超限询问；二进制大文件建议用户走手动流程。
- **并发会话同工作区**：两个会话同时模式 A 写同一工作区 → 快照分支按会话隔离（`ponda/snapshots/<session>`），结算时后者若前者未结算则提示先结算（串行化确认）。
- **OQ**：swarm 子 agent 是否每 cell 独立容器（当前设计：同一工作区共享会话容器、按 cell 隔离挂载清单；独立容器的成本/隔离收益待实测）。
- **OQ**：`git config user` 在自动 init 的仓库中取全局配置；无全局身份时用 `ponda <env>` 占位并提示。
