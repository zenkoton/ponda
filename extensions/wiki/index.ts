/**
 * ponda wiki 扩展（design: 08-wiki.md §3.3；M9）。
 * 工具注册：wiki_search / wiki_read / wiki_update —— 经 daemon RPC wiki.* 承载；
 * P4 补丁落地后由真 pi ExtensionApi 的 registerTool 挂入 agent 工具集。
 */
import type { RpcClient } from "../../packages/rpc/src/client.ts";
import { Methods } from "../../packages/rpc/src/protocol.ts";
import type { WikiSearchHit } from "../../packages/core/src/wiki.ts";

/** pi ExtensionAPI 的最小结构类型（P4 后对齐上游 registerTool 真实签名） */
export interface PiToolRegistration {
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, { type: string; description: string }>; required: string[] };
	execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface PiExtensionApi {
	registerTool(spec: PiToolRegistration): void;
}

export interface WikiToolContext {
	workspace: string;
	client: RpcClient;
}

/** 注册三件套（design 08 §3.3）；返回注册的工具表（测试可直接调用） */
export function registerWikiTools(pi: PiExtensionApi, ctx: WikiToolContext): PiToolRegistration[] {
	const tools: PiToolRegistration[] = [
		{
			name: "wiki_search",
			description: "在项目 .wiki 知识库中按关键词检索（优先于全库 grep）",
			parameters: {
				type: "object",
				properties: { query: { type: "string", description: "检索词" } },
				required: ["query"],
			},
			execute: async (args) => {
				const hits = await ctx.client.request<WikiSearchHit[]>(Methods.wikiSearch, {
					workspace: ctx.workspace,
					query: String(args.query ?? ""),
				});
				return hits.map((h) => `${h.rel}: ${h.title} (score ${h.score})`);
			},
		},
		{
			name: "wiki_read",
			description: "读取 .wiki 整页内容",
			parameters: {
				type: "object",
				properties: { page: { type: "string", description: "相对 .wiki 的路径，如 modules/auth.md" } },
				required: ["page"],
			},
			execute: async (args) => {
				const page = await ctx.client.request<{ frontmatter: unknown; body: string }>(Methods.wikiRead, {
					workspace: ctx.workspace,
					page: String(args.page ?? ""),
				});
				return page.body;
			},
		},
		{
			name: "wiki_update",
			description: "更新 .wiki 页面（hand-edited 页面自动改为追加小节）",
			parameters: {
				type: "object",
				properties: {
					page: { type: "string", description: "相对 .wiki 的路径" },
					content: { type: "string", description: "新内容或追加班节" },
				},
				required: ["page", "content"],
			},
			execute: async (args) => {
				const page = await ctx.client.request<{ rel: string }>(Methods.wikiUpdate, {
					workspace: ctx.workspace,
					page: String(args.page ?? ""),
					content: String(args.content ?? ""),
				});
				return page.rel;
			},
		},
	];
	for (const t of tools) pi.registerTool(t);
	return tools;
}

/** pi 扩展默认导出工厂（jiti 加载形态） */
export default function wikiExtension(pi: PiExtensionApi, ctx: WikiToolContext): void {
	registerWikiTools(pi, ctx);
}
