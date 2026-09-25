/**
 * ponda core 类型定义 —— 环境数据模型（design: docs/design/01-environment.md §2）。
 *
 * 术语约定：
 * - `EnvManifestInput`：manifest.json 中实际存储的"差量"形态（字段全部可缺省，鼓励最小化声明）。
 * - `EnvManifest`：沿继承链合并 + 物化后的完整形态（渲染器消费）。
 */

export const SCHEMA_VERSION = 1;

export type BuiltinTool = "read" | "bash" | "edit" | "write";
export const BUILTIN_TOOLS: readonly BuiltinTool[] = ["read", "bash", "edit", "write"];

export type Privilege = "read" | "write" | "execute";
export const PRIVILEGES: readonly Privilege[] = ["read", "write", "execute"];

export type SandboxMode = "inplace" | "worktree";
export type OutsideWorkspacePolicy = "deny" | "temp-workspace";
export type ContextStrategy = "pi-compaction" | "skill-state";
export type PermissionMode = "plan" | "approve" | "full-auto";

export type ResourceKind = "skill" | "tool" | "prompt" | "extension" | "theme" | "provider" | "model" | "mcp-server";

/** manifest 中的资源选择器（design: 02-resources.md §2） */
export type ResourceSelector = string | { name: string; version: string } | { name: string; path: string };

/** command 型自定义工具（design: 02-resources.md §5） */
export interface CommandTool {
	name: string;
	description: string;
	command: string;
	timeoutMs?: number;
	privileges?: Privilege[];
}

/** 差量删除父环境的自定义工具条目 */
export interface ToolDeletion {
	name: string;
	delete: true;
}

export type CustomToolSpec = CommandTool | ToolDeletion;

/** MCP server 声明，透传 pi-mcp-adapter 的 mcp.json 格式 */
export interface McpServerConfig {
	command?: string;
	args?: string[];
	url?: string;
	socket?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	[key: string]: unknown;
}

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic" | "google-genai";
export const PROVIDER_APIS: readonly ProviderApi[] = [
	"openai-completions",
	"openai-responses",
	"anthropic",
	"google-genai",
];

export interface ProviderDef {
	baseUrl: string;
	api: ProviderApi;
	/**
	 * 凭据：只允许引用形式（"$ENV_VAR" / "!command"，pi 原生解析）。
	 * 明文凭据由 CLI 存 env/<name>/auth.json（0600），绝不写入 manifest/models.json
	 * （design: 02 §6.1；render 会把明文自动剥离迁移）。
	 */
	apiKey?: string;
	models: { id: string; thinking?: boolean; contextWindow?: number }[];
}

export interface ModelsPolicy {
	policy: "inherit-global" | "explicit";
	/** null 值表示从父环境删除该 provider */
	providers?: Record<string, ProviderDef | null>;
}

export interface MemoryPolicy {
	enabled?: boolean;
	[key: string]: unknown;
}

/** 资源池 prompt 引用：读取 <home>/resources/prompts/<pool>/PROMPT.md */
export interface PromptRef {
	pool: string;
}

export type SystemPromptSpec = PromptRef | string;

export interface SandboxPolicy {
	mode: SandboxMode;
	autoGitInit: boolean;
	outsideWorkspace: OutsideWorkspacePolicy;
}

export interface PrivilegePolicy {
	privileges: Privilege[];
	sandbox: SandboxPolicy;
}

export interface RuntimePolicy {
	backgroundLiveness: boolean;
	contextStrategy: ContextStrategy;
	skillStateDomain?: string;
	maxParallelSubagents: number;
	permissionMode: PermissionMode;
}

/** manifest.json 的差量存储形态（子环境只存与父环境的差异） */
export interface EnvManifestInput {
	schemaVersion?: number;
	name?: string;
	base?: string;
	description?: string;
	identity?: {
		systemPrompt?: SystemPromptSpec;
		appendSystemPrompt?: string;
		memory?: MemoryPolicy;
	};
	tools?: {
		builtin?: BuiltinTool[];
		/** ToolDeletion 条目（{name, delete:true}）删除父环境同名工具 */
		custom?: CustomToolSpec[];
	};
	skills?: ResourceSelector[];
	extensions?: ResourceSelector[];
	themes?: ResourceSelector[];
	activeTheme?: string;
	/** null 值表示从父环境删除该 server */
	mcp?: Record<string, McpServerConfig | null>;
	models?: ModelsPolicy;
	privileges?: {
		privileges?: Privilege[];
		sandbox?: Partial<SandboxPolicy>;
	};
	runtime?: Partial<RuntimePolicy>;
	/** null 值表示删除父环境键位 */
	keybindings?: Record<string, string | null>;
	createdAt?: string;
	updatedAt?: string;
}

/** 物化后的完整 manifest（渲染器唯一消费形态） */
export interface EnvManifest {
	schemaVersion: typeof SCHEMA_VERSION;
	name: string;
	base?: string;
	description?: string;
	identity: {
		systemPrompt: SystemPromptSpec;
		appendSystemPrompt?: string;
		memory?: MemoryPolicy;
	};
	tools: {
		builtin: BuiltinTool[];
		custom: CommandTool[];
	};
	skills: ResourceSelector[];
	extensions: ResourceSelector[];
	themes: ResourceSelector[];
	activeTheme?: string;
	mcp: Record<string, McpServerConfig>;
	models: ModelsPolicy;
	privileges: PrivilegePolicy;
	runtime: RuntimePolicy;
	keybindings?: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

/** 全局运行态（<home>/state.json，原子写入） */
export interface PondaState {
	activeEnv: string | null;
	/** key 为工作区 realpath */
	perWorkspace?: Record<string, string>;
	activatedAt?: string;
}

export interface EnvSummary {
	name: string;
	base?: string;
	description?: string;
	skillCount: number;
	extensionCount: number;
	themeCount: number;
	sessionCount: number;
	updatedAt: string;
	lastActivatedAt?: string;
	active: boolean;
}

/** 工作区级配置（<workspace>/.ponda/ponda.json，design: 01-environment.md §7） */
export interface WorkspacePondaConfig {
	schemaVersion?: number;
	bind?: string;
	pin?: boolean;
	autoCreate?: {
		base?: string;
		skills?: string[];
		mcp?: Record<string, McpServerConfig>;
	};
	sandbox?: Partial<SandboxPolicy>;
	wiki?: { enabled?: boolean };
}
