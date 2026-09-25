/**
 * .wiki 知识库（design: docs/design/08-wiki.md；M9）。
 * - 目录规范：.wiki/{index.md, modules/, decisions/, glossary.md, conventions.md}
 * - frontmatter：title/kind/scope/updatedAt/basedOn/confidence
 * - 构建：首次全量（页面内容由构建器供给——真实链路为 agent 规划产出）；
 *   增量更新按 git diff 触及 scope 复验
 * - confidence 衰减：触及 scope 的未复验提交每条 −0.2，< 0.4 入待复验队列
 * - 倒排索引：关键词召回 + 标题加权（语义索引为可选组件，接口预留）
 */
export declare const WIKI_DIR = ".wiki";
export type WikiKind = "index" | "module" | "decision" | "glossary" | "convention";
export interface WikiFrontmatter {
	title: string;
	kind: WikiKind;
	/** 覆盖的路径前缀（可多个） */
	scope: string[];
	updatedAt: string;
	/** 生成依据的 commit */
	basedOn?: string;
	/** 上次代码变更后未经复验的衰减置信度（初始 0.9） */
	confidence: number;
	/** 人工编辑标记：agent 更新采取追加小节而非重写（design: 08 §6） */
	handEdited?: boolean;
}
export interface WikiPage {
	/** 相对 .wiki 的路径，如 modules/auth.md */
	rel: string;
	frontmatter: WikiFrontmatter;
	body: string;
}
export interface WikiSearchHit {
	rel: string;
	title: string;
	kind: WikiKind;
	score: number;
	/** 命中词摘要（片段） */
	snippet: string;
}
/** 页面生成器：真实链路为 agent（受限工具+token 预算）；测试/CLI 注入 */
export type WikiPageSupplier = (request: { rel: string; kind: WikiKind; scope: string[] }) => string | null;
export declare function wikiRoot(ws: string): string;
export declare function parseFrontmatter(text: string): {
	frontmatter: WikiFrontmatter;
	body: string;
};
export declare function serializePage(page: WikiPage): string;
export declare function listPages(ws: string): WikiPage[];
export declare function readPage(ws: string, rel: string): WikiPage | null;
export declare function writePage(ws: string, page: WikiPage): void;
/** wiki_update 工具语义：hand-edited 页面追加小节，否则整页重写并重置 confidence */
export declare function updatePage(
	ws: string,
	rel: string,
	content: string,
	opts?: {
		title?: string;
	},
): WikiPage;
export interface BuildOptions {
	/** 模块页供给（真实链路：agent 受限工具+预算产出；此处注入） */
	moduleSupplier?: WikiPageSupplier;
	head?: string;
}
/** 首次构建：骨架（index/glossary/conventions）+ 模块页 */
export declare function buildWiki(
	ws: string,
	opts?: BuildOptions,
): {
	created: string[];
};
/** 增量更新：git diff（basedOn..HEAD）触及 scope 的页面复验（08 §3.1） */
export declare function refreshWiki(
	ws: string,
	opts: BuildOptions & {
		supplier: WikiPageSupplier;
	},
): {
	refreshed: string[];
	reviewed: string[];
};
/** confidence 衰减复验（08 §3.1：触及 scope 的未复验提交每条 −0.2） */
export declare function decayConfidence(ws: string): {
	decayed: {
		rel: string;
		confidence: number;
	}[];
	needsReview: string[];
};
export interface InvertedIndex {
	/** term（小写词元）→ 页面 rel 列表 */
	postings: Record<string, string[]>;
	titles: Record<string, string>;
}
export declare function buildIndex(pages: WikiPage[]): InvertedIndex;
/** wiki_search：关键词召回 + 标题加权（语义索引为可选组件，后续接入同一接口） */
export declare function searchWiki(index: InvertedIndex, query: string, limit?: number): WikiSearchHit[];
//# sourceMappingURL=wiki.d.ts.map
