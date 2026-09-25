# 01 · 环境管理（`ponda env`）

> 环境是 ponda 的核心抽象。本文定义环境的数据模型、CLI 规格、继承与合并语义、shell 集成与配置文件驱动流程。

## 1. 模块目标与需求映射

| readme 需求 | 本文章节 |
|---|---|
| `ponda env create / rm / activate` 手动管理 | §4 |
| `--base` 环境继承 | §3 |
| 默认 pi 配置文件示例（system_prompt/tools/skills/prompt/privileges） | §2 |
| bash/zsh/fish 快捷键与提示符 `(pi:default)` | §6 |
| 配置文件自动创建和切换环境 | §7 |
| 切换后 pi 自动连接不同执行文件目录；skills 等经软链接独立 | §5 + 00 §4 |

## 2. 环境数据模型

### 2.1 EnvManifest（`envs/<name>/manifest.json`，唯一事实源）

```ts
interface EnvManifest {
  schemaVersion: 1;
  name: string;                      // ^[a-z][a-z0-9-]{0,63}$，保留字见 §4.1
  base?: string;                     // 继承的父环境名，构成 DAG（禁环）
  description?: string;

  identity: {
    systemPrompt: PromptRef | string;    // PromptRef = { pool: string } 引用资源池 prompt；string 为内联
    appendSystemPrompt?: string;
    memory: MemoryPolicy;                // 见 02 §7
  };

  tools: ToolPolicy;
  skills: ResourceSelector[];            // 见 02 §3
  extensions: ResourceSelector[];
  themes: ResourceSelector[];
  activeTheme?: string;
  mcp: Record<string, McpServerConfig>;  // 透传 pi-mcp-adapter 格式
  models: ModelsPolicy;                  // 见 02 §6

  privileges: PrivilegePolicy;           // 沙箱与权限，见 03 §6
  runtime: RuntimePolicy;                // 见 05 §1
  keybindings?: Record<string, string>;  // pi keybindings.json 渲染源

  createdAt: string;                     // ISO 8601
  updatedAt: string;
}

interface ToolPolicy {
  builtin: ('read' | 'bash' | 'edit' | 'write')[];   // pi 内置工具的启停
  custom: CommandTool[];                // command 型自定义工具（readme 配置示例）
}
interface CommandTool {
  name: string;
  description: string;
  command: string;                      // shell 命令模板，$ARGUMENTS 占位
  timeoutMs?: number;
  privileges?: Privilege[];             // 该工具需要的权限，触发申请
}

interface RuntimePolicy {
  backgroundLiveness: boolean;          // 后台存活，见 05 §5
  contextStrategy: 'pi-compaction' | 'skill-state';   // 见 06 §1
  skillStateDomain?: string;            // 启用 skill-state 时的领域 schema id
  maxParallelSubagents: number;         // swarm 并发上限
  permissionMode: 'plan' | 'approve' | 'full-auto';   // TUI 模式切换的默认值
}

interface PrivilegePolicy {
  privileges: ('read' | 'write' | 'execute')[];   // 环境基线权限
  sandbox: {
    mode: 'inplace' | 'worktree';       // 工作区内写入策略，见 03 §3
    autoGitInit: boolean;               // 无 .git 时是否自动初始化
    outsideWorkspace: 'deny' | 'temp-workspace';  // 工作区外文件策略
  };
}
```

### 2.2 渲染产物（manifest → pi 消费文件）

| 渲染目标 | 规则 |
|---|---|
| `settings.json` | extensions 数组（含 ponda 内置扩展 + 环境启用扩展，`+路径` 语法）、theme、compaction、enableSkillCommands 等由 manifest 各节拼装 |
| `SYSTEM.md` | `identity.systemPrompt` 解析（池引用读 `resources/prompts/<name>/`，支持 frontmatter 模板变量 `${env.name}`） |
| `models.json` | `models.policy` 展开（共享定义软链或内联，见 02 §6） |
| `mcp.json` | `mcp` 节原样写出 |
| `keybindings.json` | `keybindings` 节原样写出 |
| skills/extensions/themes/prompts 目录 | 软链接注入，见 02 §4 |

渲染是**幂等**的：`render(env)` 输入相同必产出相同文件集。`ponda env activate` 每次激活前重渲染；`ponda env doctor` 对比渲染产物与磁盘差异报告漂移。

### 2.3 默认配置（`ponda env create default`）

首次使用 `ponda init` 时自动创建名为 `default` 的基础环境，内容即 readme 中的默认配置示例：

```jsonc
{
  "schemaVersion": 1,
  "name": "default",
  "identity": { "systemPrompt": "You are a helpful coding agent." },
  "tools": {
    "builtin": ["read", "bash", "edit", "write"],
    "custom": []
  },
  "skills": [], "extensions": ["ponda-core-ext"], "themes": [],
  "mcp": {},
  "models": { "policy": "inherit-global" },
  "privileges": {
    "privileges": ["read", "write", "execute"],
    "sandbox": { "mode": "inplace", "autoGitInit": true, "outsideWorkspace": "temp-workspace" }
  },
  "runtime": {
    "backgroundLiveness": true,
    "contextStrategy": "pi-compaction",
    "maxParallelSubagents": 3,
    "permissionMode": "approve"
  }
}
```

## 3. 继承与配置合并语义

环境通过 `base` 形成 DAG（默认以 `default` 为根）。生效配置 = 沿继承链**自根向下逐层合并**：

```
effective(env) = merge(effective(base(env)), env.manifest)
```

### 3.1 逐字段合并策略表

| 字段 | 策略 |
|---|---|
| `description` / `activeTheme` / 标量类 | 子环境显式声明则覆盖，否则继承 |
| `identity.systemPrompt` | 整体覆盖（prompt 是语义单元，不做字符串拼接；需要叠加用 `appendSystemPrompt`） |
| `identity.appendSystemPrompt` | 字符串拼接：`base + "\n\n" + child` |
| `tools.builtin` | 集合覆盖（子声明即全量替换，避免歧义；`ponda env diff` 可对比） |
| `tools.custom` | 按 `name` 键合并：子同名覆盖父，新增追加；`null` 值表示删除父项 |
| `skills` / `extensions` / `themes`（ResourceSelector 列表） | **并集合并**：按 `name` 去重子优先；selector 支持 `!name` 排除父环境项（`{"name": "!pdf-tools"}`） |
| `mcp` | 字典按键合并，子覆盖同名 server；`null` 值删除 |
| `models` | `ModelsPolicy` 深合并（见 02 §6） |
| `privileges` / `runtime` / `keybindings` | 深合并（对象递归，标量覆盖；数组同 `tools.builtin` 全量替换语义，除 `privileges.privileges` 为集合并集） |
| `createdAt/updatedAt/name/base` | 不参与合并 |

深合并统一定义：对象 → 递归；数组 → 按字段的既定策略（上表）；`null` → 删除目标键。

### 3.2 继承约束

- 创建时校验无环（DFS）；`--base` 指向不存在的环境报错（除非同时 `--from-template`）。
- `ponda env rm` 拒绝删除仍被 `base` 引用的环境（列出引用方，`--force` 会将引用方改为继承被删环境的父级，需二次确认）。
- 继承是**动态**的：修改父环境后子环境下次激活即生效（合并发生在渲染时）；`ponda env freeze <name>` 可将当前生效配置快照为独立 manifest（切断继承），用于发布/共享。

## 4. CLI 规格

通用：所有子命令支持 `--json` 机器可读输出；退出码见 00 §8。环境名大小写敏感，建议小写。

### 4.1 `ponda env create <env_name>`

```
ponda env create <name> [--base <base_env>] [--template <tpl>] [--from-sample <file>]
                 [--system-prompt <text|@file>] [--tool <name=command>]...
                 [--skill <name>]... [--extension <name>]... [--theme <name>]
                 [--privilege read|write|execute]... [--no-render]
```

流程：
1. 校验名称合法且不与现有环境/一级子命令冲突（保留字：`env skills tools provider model prompt memory extension theme history tui goal init doctor`）。
2. 解析 `--base`（默认继承 `default`）→ 计算 base 的 effective 配置。
3. 写入 `envs/<name>/manifest.json`（仅存差异于父环境的字段，鼓励最小化声明）。
4. 渲染 agent dir（除非 `--no-render`）。
5. 输出：创建成功、继承链、启用的资源数量；提示 `ponda env activate <name>`。

交互模式（无任何选项时）：向导式依次询问 description → system prompt（默认/内联/从池选择）→ 权限 → 沙箱策略 → 初始 skills。

### 4.2 `ponda env rm <env_name>`

```
ponda env rm <name> [--force]
```

- 激活中的环境不可删（提示先切换）。
- 被继承引用时见 §3.2。
- 删除动作：移入 `~/.ponda/.trash/envs/<name>-<ts>/`（保留 7 天可恢复），不直接 rm；`--force` 跳过回收站。
- 若目标环境有正在运行的 daemon 会话，拒绝并列出会话。

### 4.3 `ponda env activate <env_name>`

```
ponda env activate <name> [--dry-run]
```

流程：
1. 存在性校验 → 重渲染 manifest → `state.json` 原子写入 `{ activeEnv, activatedAt, workspace? }`。
2. shell 集成钩子感知变更（§6.3）更新提示符；（兼容）导出 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR` 供外部脚本消费——ponda 入口自身以 state.json 为准（§5）。
3. 输出新提示符预览：`(pi:web-dev)`。
4. 若工作区 `.ponda/ponda.json` 绑定了其他环境，警告冲突并说明优先级（§7.2）。

`--dry-run`：渲染并打印将要发生的目录/环境变量变化，不写状态。

### 4.4 `ponda env list` / `ponda env info`

- `list`：表格输出 name / base / 简述 / 资源数（skills·exts·themes）/ 会话数 / 最后激活时间 / 是否当前激活（`*` 标记）。
- `info <name>`：继承链、effective 配置分节打印（标明来源层 `base ← child`）、渲染产物路径、磁盘占用。

辅助命令：
- `ponda env diff <a> <b>`：两个环境 effective 配置的结构化 diff。
- `ponda env export <name> [-o dir]`：导出 manifest + 私有资源 + 软链接清单（可提交 git 共享）。
- `ponda env import <dir>`：校验后导入。
- `ponda env rename <old> <new>`、`ponda env doctor`（见 00 §8）。

## 5. 激活态与切换的运行语义

- **state.json** 是 ponda CLI 与 shell 集成、daemon 的共享事实源：`{ activeEnv, perWorkspace?: Record<path, env>, activatedAt }`。
- **入口原生定位（fork 收益，00 §1.1）**：`ponda` 即 fork 后的 pi 入口，启动时直接读 state.json 解析当前环境 agent dir，不依赖 shell 集成与环境变量（脚本/CI 天然可用）；`PI_CODING_AGENT_DIR` 保留为显式覆盖手段，shell 集成的导出仅为子进程兼容。
- **原子性**：state.json 写入采用 临时文件 + `rename`；渲染产物同样先写 `.staging` 再整体 swap，避免半渲染状态被读到。
- 环境切换即"连接到不同的执行文件目录"：入口按 state.json 指向的环境目录加载该环境的 SYSTEM.md、扩展、主题、模型与会话历史——readme 中"ponda 切换环境后，pi 自动连接到不同的执行文件目录"由此实现。

## 6. Shell 集成

### 6.1 安装

```
ponda init            # 交互式：创建 default 环境 + 检测当前 shell 并写集成
ponda init bash|zsh|fish --append   # 追加到 rc 文件；--print 仅输出脚本内容
```

### 6.2 职责

集成脚本（约 40 行/shell，全部逻辑在 `ponda _hook` 子命令中，脚本只做调用）负责三件事：

1. **提示符**：每次 prompt 前调用 `ponda _hook prompt`，输出 `(pi:<env>)` 片段供用户嵌入 `PS1`（自动尝试常见框架：oh-my-zsh/powerlevel10k/fish starship 的接入点，检测不到则打印手工嵌入说明）。
2. **环境变量同步（兼容）**：`ponda _hook env` 输出 `export PI_CODING_AGENT_DIR=...` 等供外部脚本/子进程消费（ponda 入口不依赖它，见 §5）；缓存于 `state.json` 的 mtime，无变化时零开销。
3. **目录切换自动激活**（chpwd）：进入含 `.ponda/ponda.json` 的工作区时自动执行 `ponda env activate <绑定环境>`（§7）。

### 6.3 快捷键（readme：通过快捷键快速切换环境和执行常用命令）

| 键（默认，zsh/bash；fish 用 `bind` 等价） | 动作 |
|---|---|
| `Ctrl-P e` | `ponda env list` + fzf 式选择激活 |
| `Ctrl-P c` | 快速创建环境（预填名称） |
| `Ctrl-P d` | `ponda env rm` 选择删除 |
| `Ctrl-P i` | `ponda env info <当前>` |

序列前缀 `Ctrl-P` 作为 ponda 命名空间，避免与常用绑定冲突；快捷键定义写入集成脚本并可经 `~/.ponda/ponda.json` 的 `shell.keybindings` 关闭或改键。

## 7. 配置文件驱动的自动创建与切换

### 7.1 工作区配置文件（`<workspace>/.ponda/ponda.json`）

```jsonc
{
  "schemaVersion": 1,
  "bind": "web-dev",              // 进入该工作区应激活的环境
  "autoCreate": {                  // bind 的环境不存在时按此创建（一次性）
    "base": "default",
    "skills": ["react", "vitest"],
    "mcp": { "browser": { "command": "npx", "args": ["-y", "@mcp/browser"] } }
  },
  "sandbox": { "mode": "worktree" },   // 工作区级沙箱覆盖（合并进 env 生效配置）
  "wiki": { "enabled": true }
}
```

- 该文件是**团队共享资产**（提交进 git）；`bind` 描述"此项目推荐环境"，机器本地覆盖写 `~/.ponda/state.json` 的 `perWorkspace`。
- `autoCreate` 首次进入时执行 `ponda env create web-dev --base default ...`（幂等：环境已存在则只校验差异并提示）。

### 7.2 优先级与冲突

当前环境 = `perWorkspace[workspace]`（本地绑定） > `.ponda/ponda.json#bind`（项目推荐） > `activeEnv`（全局） > `default`。冲突时 chpwd 钩子提示但不静默覆盖全局激活，除非 `ponda.json` 声明 `"pin": true`。

## 8. 边界情况与开放问题

- **环境变量泄漏到子进程**：`PI_CODING_AGENT_DIR` 一旦导出，嵌套 shell 沿用；集成脚本在 `deactivate`（`ponda env activate` 到无绑定目录）时清理。提供 `ponda env deactivate` 显式恢复全局态。
- **同一 shell 多标签页**：各标签共享 state.json，激活互相可见（与 conda 的行为一致）；若需标签级隔离，用户可 `PONDA_HOME=<tmp> ponda ...` 建立独立实例。
- **回收站清理**：`.trash` 由 `ponda doctor --prune` 清理，不做后台任务。
- **OQ**：`--base` 多继承（`--base a --base b`）是否值得引入（当前设计明确单继承，复杂度收益比不佳）。
