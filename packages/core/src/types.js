/**
 * ponda core 类型定义 —— 环境数据模型（design: docs/design/01-environment.md §2）。
 *
 * 术语约定：
 * - `EnvManifestInput`：manifest.json 中实际存储的"差量"形态（字段全部可缺省，鼓励最小化声明）。
 * - `EnvManifest`：沿继承链合并 + 物化后的完整形态（渲染器消费）。
 */
export const SCHEMA_VERSION = 1;
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];
export const PRIVILEGES = ["read", "write", "execute"];
export const PROVIDER_APIS = [
    "openai-completions",
    "openai-responses",
    "anthropic",
    "google-genai",
];
//# sourceMappingURL=types.js.map