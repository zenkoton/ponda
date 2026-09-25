# 02 · 资源管理（skills / tools / provider / model / prompt / memory / extension / theme / history）

> 七类资源共用一套"资源池 + 环境启用清单 + 软链接注入"模型；memory 与 history 是环境附属数据的管理面。本文同时定义跨环境免切换操作。

## 1. 模块目标与需求映射

| readme 需求 | 本文章节 |
|---|---|
| `ponda skills list/add/rm/update/info` | §4（其余类别同构） |
| `ponda tools list/add/rm/update/info` | §4 + §5 |
| `ponda provider/model ...` 交互式配置 | §6 |
| `ponda prompt ...` | §4 |
| `ponda memory reset` | §7 |
| `ponda extension ...` / `ponda theme ...` | §4 |
| `ponda history list/attach/rm/info/search` | §8 |
| skills 等配置独立目录 + 软链接到当前环境执行目录 | §3 |
| `ponda <env name> skill list` 免切换操作 | §9 |

## 2. 统一资源模型

```ts
type ResourceKind =
  | 'skill' | 'tool' | 'prompt' | 'extension' | 'theme'
  | 'provider' | 'model' | 'mcp-server';

/** 资源池内每个实体的元数据（resources/<kind>s/<name>/resource.json） */
interface ResourceMeta {
  kind: ResourceKind;
  name: string;                 // 池内唯一（kind 内）
  version: string;              // semver
  source: {
    type: 'builtin' | 'registry' | 'local';
    origin?: string;            // npm:xxx / git:url / 本地路径 / 'ponda-builtin'
    digest?: string;            // 内容哈希，检测本地篡改
  };
  description?: string;
  entry: string;                // 相对资源根的入口（SKILL.md / index.ts / theme.json...）
  installedAt: string;
  updatedAt: string;
  depends?: ResourceSelector[]; // 资源间依赖（如 extension 依赖某 tool）
}

/** 环境启用清单中的选择器（manifest 中各 kind 数组的元素） */
type ResourceSelector =
  | string                       // 'react' —— 启用池内最新
  | { name: string; version: string }   // 'react@2.1.0' —— 固定版本
  | { name: string; path: string };     // 私有资源：环境目录内相对路径
```

三类来源：

- **builtin**：ponda 发行版自带（`extensions/` 目录随 npm 包分发），如 ponda-core-ext、todolist、goal 等。
- **registry**：经 pi packages 通道安装（`npm:` / `git:` / 本地路径三者 pi 均支持，ponda 复用 `pi install` 的解析逻辑），安装到池内并登记 resource.json。
- **local**：用户手放进池（`ponda skills add ./my-skill` 拷贝入池）或作为私有资源直接放环境目录。

## 3. 池 → 环境的软链接注入

**这一节实现 readme 的关键机制**："每个 pi 的 skills 等配置文件都存在独立的一个目录，通过软连接到当前环境的执行文件目录"。

- 资源实体**只存一份**于 `~/.ponda/resources/<kind>s/<name>@<version>/`（多版本共存）。
- 环境渲染时（01 §2.2），对 manifest 启用清单逐项在 `envs/<env>/<kind>s/` 下创建**相对软链接**：

```
envs/web-dev/skills/react -> ../../resources/skills/react@2.1.0
envs/web-dev/extensions/ponda-core-ext -> ../../resources/extensions/ponda-core-ext@1.0.0
```

- 私有资源（selector 的 `path` 形态）直接存放在环境目录内，不参与链接。
- **注入即隔离**：pi 只读环境的 agent dir，看到的就是该环境自己的 skills/extensions/themes 目录；池内更新版本后重渲染即在全环境生效（或按 pinned 版本保持不变）。
- 断链自检：`ponda doctor` 扫描环境目录内指向池外/已删除目标的软链接。
- Windows/不支持符号链接的文件系统：降级为 junction（Windows 目录链接）或拷贝（`resource.json` 记录 `linkMode: copy`，update 时重新拷贝）。

## 4. 通用管理命令（以 skills 为例，七类同构）

```
ponda skills list [--env <env>] [--available]        # --available 列池内未启用项
ponda skills add <name|path|npm:pkg|git:url> [--env <env>] [--version <v>]
ponda skills rm <name> [--env <env>] [--purge]       # --purge 同时从池中删除
ponda skills update [name] [--env <env>]             # 无 name 更新该环境全部
ponda skills info <name> [--env <env>]
```

语义拆解（**两级模型**，所有类别一致）：

- `add` = ①（若来自 registry/local）装入资源池 + 登记 meta；② 写入目标环境 manifest 的对应数组 + 重渲染（创建软链接）。`--env` 缺省为当前激活环境。
- `rm` = 从环境 manifest 移除 + 删软链接；`--purge` 再删池（被其他环境引用时拒绝并列出）。
- `update` = 池内拉取新版本（registry 类）→ 若环境未 pin 版本则重定向软链接到新版本；pin 的环境不动并提示。
- `info` = meta + 启用它的环境列表 + 版本 + 入口文件预览。
- `list` = 表格：名称 / 版本 / 来源 / 私有标记 / 描述首行。

**各类别落地差异**：

| 类别 | 池内实体形态 | 入环境方式 |
|---|---|---|
| skill | 目录（SKILL.md + scripts/references/assets，遵循 Agent Skills spec） | 软链到 `env/skills/` |
| extension | TS 模块（默认导出工厂函数） | 软链到 `env/extensions/` + settings.json extensions 数组登记 |
| theme | `<name>.json`（pi 主题格式，文件名=主题名） | 软链到 `env/themes/` |
| prompt | 目录（PROMPT.md + meta） | 软链到 `env/prompts/`，供 systemPrompt 引用或 `/prompt` 使用 |
| tool | 目录（tool.json + 可选脚本，见 §5） | 写入 manifest `tools.custom` + 由 ponda-core-ext 注册为 pi 工具 |
| provider/model | JSON 定义文件 | 写入 `env/models.json`（渲染），见 §6 |
| mcp-server | JSON 片段 | 写入 manifest `mcp` 字典 → 渲染进 `env/mcp.json` |

## 5. 自定义工具（command tool）

对应 readme 默认配置中的 tools 示例（name/description/command）：

```jsonc
// resources/tools/deploy/tool.json
{
  "name": "deploy",
  "description": "Deploy the current branch to staging. Usage: deploy <branch>",
  "command": "./scripts/deploy.sh $ARGUMENTS",
  "timeoutMs": 300000,
  "privileges": ["execute"]
}
```

- 由 **ponda-core-ext** 在 agent 启动时（fork 入口，00 §1.1）读取 manifest `tools.custom`，逐个 `pi.registerTool()`：参数 schema 固定为 `{ arguments: string }`，execute 时 spawn shell 并回传 stdout/stderr/exit code。
- `privileges` 非空 → 执行前走权限申请流程（03 §6）。
- `ponda tools add deploy --command './scripts/deploy.sh $ARGUMENTS' --desc '...'` 一条命令完成池登记 + 环境启用。

## 6. Provider / Model 管理（交互式）

readme 明确"provider 和 model 都是复杂配置，提供交互式配置方式"。设计为向导 + 可共享定义两层：

### 6.1 数据

```ts
interface ModelsPolicy {          // manifest.models
  policy: 'inherit-global' | 'explicit';
  providers?: Record<string, ProviderDef | null>;  // null = 从父环境删除
}
interface ProviderDef {           // 与 pi models.json 的 provider 格式对齐
  baseUrl: string;
  api: 'openai-completions' | 'openai-responses' | 'anthropic' | 'google-genai';
  apiKey: string;                 // 支持 '$ENV_VAR' 与 '!command' 取密钥
  models: { id: string; thinking?: boolean; contextWindow?: number }[];
}
```

- 池内 `resources/models/<name>.json` 存整套 ProviderDef，环境引用（软语义：渲染时展开进 `env/models.json`，凭据写 `env/auth.json` 0600）。
- 内置目录（pi 官方模型目录）始终可用，向导中标记 `(builtin)`。

### 6.2 `ponda provider add`（交互式向导流程）

```
1. 选择 API 类型      → openai-completions / anthropic / google-genai / openai-responses
2. baseUrl           → 默认按 API 类型给官方端点，自定义可改
3. 凭据              → 直接粘贴 / $ENV_VAR / !command（推荐后两者，避免落盘）
4. 发现模型          → 调 /models 列出（失败则手输 id 列表）
5. 勾选纳入的模型     → 多选；逐个可设 thinking/contextWindow
6. 写入目标          → 仅当前环境 / 存入池供共享（默认池 + 当前环境启用）
```

`provider list`：表格 provider / API 类型 / 模型数 / 凭据来源（`$ENV`/`!cmd`/明文⚠）/ 引用环境数。`model list`：聚合视图（provider 维度分组，标注当前默认模型）；`model add/update` 支持为单个模型调元数据；`provider|model rm/info` 同通用语义。

### 6.3 与运行时（fork）的对接

渲染进 `env/models.json` 后，pi 的三层模型解析（内置目录 → models.json → 扩展 provider）在 fork 入口内自动生效；ponda 不拦截模型调用，仅在 telemetry 侧记账成本（pi-ai 已提供用量事件）。

## 7. Memory 管理

- 环境记忆是**环境级**数据：跨会话保留、随环境隔离。物化为 `env/<name>/memory/`：
  - `MEMORY.md`：长期记忆正文（agent 经 ponda-core-ext 提供的 `memory_write` 工具追加，渲染时并入 APPEND_SYSTEM.md 尾部注入）。
  - `facts.json`：结构化事实（kv，供 skill-state 领域 schema 引用，见 06 §4）。
- `ponda memory reset`：清空 MEMORY.md 与 facts.json（移入 `.trash`，可恢复）；`--hard` 连会话引用一并清理。readme 仅要求 reset，`list/info` 以只读视图形式提供（打印当前记忆条数/最近更新/大小）。

## 8. History 管理（跨环境会话索引）

会话本体是各环境 `sessions/` 下的 pi JSONL；history 命令操作一个**派生索引**（首次扫描构建，之后 daemon/CLI 写会话时增量更新；`ponda history rebuild` 全量重建）。

```ts
interface HistoryEntry {
  sessionId: string;          // pi 会话 id
  env: string;
  workspace: string | null;
  title: string;              // 首条用户消息摘要（≤60 字符）
  lastActiveAt: string;
  entryCount: number;
  tokens: { input: number; output: number };
  cost: number;
  status: 'running' | 'detached' | 'ended';
  taskGoal?: string;          // 若会话含 goal 任务
}
```

| 命令 | 行为 |
|---|---|
| `ponda history list [--env] [--workspace] [--status running]` | 按最后活跃排序的表格，`--json` 输出索引 |
| `ponda history attach <id>` | 用**该会话所属环境**恢复会话：`pi --resume <session> --session-dir <env>/sessions`；若与当前激活环境不同，打印提示（可 `--switch-env` 顺带激活） |
| `ponda history rm <id>` | 删除 JSONL（进 .trash） |
| `ponda history info <id>` | 条目详情 + 树形分支概览（读取 JSONL 的 parent 链渲染） |
| `ponda history search <keyword>` | 全文检索（ripgrep 子进程，无 rg 时降级 JS 扫描）：命中会话/条目摘要与跳转信息 |

## 9. 跨环境免切换操作

readme："提供一个不用切换环境就可以使用不同的agent的功能"，形如 `ponda <env name> skill list`。

### 9.1 语法与消歧

```
ponda <env-name> <resource-group> <action> [...]     # ponda web-dev skills list
ponda <env-name> <resource-group> add <name> [...]   # 直接往目标环境装资源
```

- 仅当第一参数**精确匹配现有环境名**时走此语法；环境名在创建时已被禁止与一级子命令重名（01 §4.1），故无歧义。
- 该语法是 `--env <name>` 的糖：`ponda web-dev skills list` ≡ `ponda skills list --env web-dev`，全类别资源命令与 `history` 均支持。
- **边界**：涉及"运行 agent"的命令（goal、tui 对话）不在免切换范围——它们必须明确环境上下文，仍需 activate 或 `--env` 显式传参。

### 9.2 实现要点

所有资源命令统一先解析"目标环境上下文"（参数 `--env` > 免切换语法 > 当前激活），再进入通用命令实现；manifest 修改走环境文件锁（00 §8）。

## 10. 边界情况与开放问题

- **同名不同类**：`skills/foo` 与 `themes/foo` 互不冲突（命名空间按 kind）；`resource.json` 的 `depends` 引用带 kind 前缀。
- **registry 安装的安全**：第三方 extension 是任意 TS 代码，`add` 时显著提示并要求确认（`--yes` 跳过）；digest 记录后 update 时校验。
- **池的多版本共存**：默认保留最近 3 个版本，`ponda skills prune` 清理无环境引用的旧版本。
- **OQ**：资源池是否引入 scope/命名空间（`@org/name`）以支撑未来团队共享（对应 00 §9 Q2）。
- **OQ**：pi packages 画廊（`pi-package` keyword）与 ponda 池的双向可见性——暂定单向（pi 可装的东西 ponda 都能装；ponda 池内 builtin 不发布到 pi 画廊）。
