/**
 * .wiki 知识库（design: docs/design/08-wiki.md；M9）。
 * - 目录规范：.wiki/{index.md, modules/, decisions/, glossary.md, conventions.md}
 * - frontmatter：title/kind/scope/updatedAt/basedOn/confidence
 * - 构建：首次全量（页面内容由构建器供给——真实链路为 agent 规划产出）；
 *   增量更新按 git diff 触及 scope 复验
 * - confidence 衰减：触及 scope 的未复验提交每条 −0.2，< 0.4 入待复验队列
 * - 倒排索引：关键词召回 + 标题加权（语义索引为可选组件，接口预留）
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WIKI_DIR = ".wiki";

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

const DEFAULT_CONFIDENCE = 0.9;
const DECAY_PER_COMMIT = 0.2;
const REVIEW_THRESHOLD = 0.4;

export function wikiRoot(ws: string): string {
	return join(ws, WIKI_DIR);
}

// —— frontmatter ——

export function parseFrontmatter(text: string): { frontmatter: WikiFrontmatter; body: string } {
	const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (m === null) {
		return {
			frontmatter: {
				title: "",
				kind: "module",
				scope: [],
				updatedAt: new Date().toISOString(),
				confidence: DEFAULT_CONFIDENCE,
			},
			body: text,
		};
	}
	const fm: Record<string, string> = {};
	for (const line of (m[1] ?? "").split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	const scope = (fm.scope ?? "")
		.split(/[,\s]+/)
		.map((s) => s.replace(/\/$/, ""))
		.filter(Boolean);
	const kind = (["index", "module", "decision", "glossary", "convention"] as const).includes(fm.kind as never)
		? (fm.kind as WikiKind)
		: "module";
	return {
		frontmatter: {
			title: fm.title ?? "",
			kind,
			scope,
			updatedAt: fm.updatedAt ?? new Date().toISOString(),
			basedOn: fm.basedOn || undefined,
			confidence: fm.confidence !== undefined ? Number.parseFloat(fm.confidence) : DEFAULT_CONFIDENCE,
			handEdited: fm.handEdited === "true" || undefined,
		},
		body: (m[2] ?? "").replace(/^\n/, ""),
	};
}

export function serializePage(page: WikiPage): string {
	const fm = page.frontmatter;
	const lines = [
		"---",
		`title: ${fm.title}`,
		`kind: ${fm.kind}`,
		`scope: ${fm.scope.join(", ")}`,
		`updatedAt: ${fm.updatedAt}`,
	];
	if (fm.basedOn !== undefined) lines.push(`basedOn: ${fm.basedOn}`);
	lines.push(`confidence: ${fm.confidence}`);
	if (fm.handEdited === true) lines.push("handEdited: true");
	lines.push("---", "", page.body);
	return `${lines.join("\n")}\n`;
}

// —— 读写 ——

export function listPages(ws: string): WikiPage[] {
	const root = wikiRoot(ws);
	if (!existsSync(root)) return [];
	const out: WikiPage[] = [];
	const walk = (dir: string, relPrefix: string): void => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const rel = relPrefix.length > 0 ? `${relPrefix}/${e.name}` : e.name;
			if (e.isDirectory()) walk(join(dir, e.name), rel);
			else if (e.name.endsWith(".md")) {
				const parsed = parseFrontmatter(readFileSync(join(dir, e.name), "utf8"));
				out.push({ rel, frontmatter: parsed.frontmatter, body: parsed.body });
			}
		}
	};
	walk(root, "");
	return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

export function readPage(ws: string, rel: string): WikiPage | null {
	const file = join(wikiRoot(ws), rel);
	if (!existsSync(file)) return null;
	const parsed = parseFrontmatter(readFileSync(file, "utf8"));
	return { rel, frontmatter: parsed.frontmatter, body: parsed.body };
}

export function writePage(ws: string, page: WikiPage): void {
	const file = join(wikiRoot(ws), page.rel);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, serializePage(page), "utf8");
}

/** wiki_update 工具语义：hand-edited 页面追加小节，否则整页重写并重置 confidence */
export function updatePage(ws: string, rel: string, content: string, opts: { title?: string } = {}): WikiPage {
	const existing = readPage(ws, rel);
	const now = new Date().toISOString();
	if (existing !== null && existing.frontmatter.handEdited === true) {
		const updated: WikiPage = {
			rel,
			frontmatter: { ...existing.frontmatter, updatedAt: now, confidence: DEFAULT_CONFIDENCE },
			body: `${existing.body.replace(/\s*$/, "")}\n\n## 更新（${now.slice(0, 10)}）\n\n${content}\n`,
		};
		writePage(ws, updated);
		return updated;
	}
	const fm: WikiFrontmatter =
		existing !== null
			? { ...existing.frontmatter, updatedAt: now, confidence: DEFAULT_CONFIDENCE }
			: {
					title: opts.title ?? rel,
					kind: kindForRel(rel),
					scope: [],
					updatedAt: now,
					confidence: DEFAULT_CONFIDENCE,
				};
	const updated: WikiPage = { rel, frontmatter: fm, body: existing !== null ? content : `${content}\n` };
	writePage(ws, updated);
	return updated;
}

function kindForRel(rel: string): WikiKind {
	if (rel.startsWith("modules/")) return "module";
	if (rel.startsWith("decisions/")) return "decision";
	if (rel === "glossary.md") return "glossary";
	if (rel === "conventions.md") return "convention";
	if (rel === "index.md") return "index";
	return "module";
}

// —— 构建（08 §3）——

export interface BuildOptions {
	/** 模块页供给（真实链路：agent 受限工具+预算产出；此处注入） */
	moduleSupplier?: WikiPageSupplier;
	head?: string;
}

/** 首次构建：骨架（index/glossary/conventions）+ 模块页 */
export function buildWiki(ws: string, opts: BuildOptions = {}): { created: string[] } {
	const head = opts.head ?? gitHead(ws);
	const now = new Date().toISOString();
	const created: string[] = [];
	const skeleton: WikiPage[] = [
		{
			rel: "index.md",
			frontmatter: {
				title: "项目知识库",
				kind: "index",
				scope: [],
				updatedAt: now,
				basedOn: head,
				confidence: DEFAULT_CONFIDENCE,
			},
			body: "# 项目知识库\n\n模块导航见 modules/；决策记录见 decisions/。\n",
		},
		{
			rel: "glossary.md",
			frontmatter: {
				title: "术语表",
				kind: "glossary",
				scope: [],
				updatedAt: now,
				basedOn: head,
				confidence: DEFAULT_CONFIDENCE,
			},
			body: "# 术语表\n\n- 术语：定义（相关代码位置）\n",
		},
		{
			rel: "conventions.md",
			frontmatter: {
				title: "代码约定",
				kind: "convention",
				scope: [],
				updatedAt: now,
				basedOn: head,
				confidence: DEFAULT_CONFIDENCE,
			},
			body: "# 代码约定\n\n（从 AGENTS.md/lint 配置提炼）\n",
		},
	];
	for (const p of skeleton) {
		if (readPage(ws, p.rel) === null) {
			writePage(ws, p);
			created.push(p.rel);
		}
	}
	const supplier = opts.moduleSupplier;
	if (supplier !== undefined) {
		for (const dir of listSourceDirs(ws)) {
			const rel = `modules/${dir.name}.md`;
			const body = supplier({ rel, kind: "module", scope: [`${dir.name}/`] });
			if (body === null || readPage(ws, rel) !== null) continue;
			writePage(ws, {
				rel,
				frontmatter: {
					title: `${dir.name} 模块`,
					kind: "module",
					scope: [`${dir.name}/`],
					updatedAt: now,
					basedOn: head,
					confidence: DEFAULT_CONFIDENCE,
				},
				body,
			});
			created.push(rel);
		}
	}
	return { created };
}

/** 增量更新：git diff（basedOn..HEAD）触及 scope 的页面复验（08 §3.1） */
export function refreshWiki(
	ws: string,
	opts: BuildOptions & { supplier: WikiPageSupplier },
): { refreshed: string[]; reviewed: string[] } {
	const head = opts.head ?? gitHead(ws);
	const refreshed: string[] = [];
	const reviewed: string[] = [];
	for (const page of listPages(ws)) {
		if (page.frontmatter.scope.length === 0) continue;
		const changed = changedPaths(ws, page.frontmatter.basedOn ?? page.frontmatter.updatedAt, head);
		const touched = changed.filter((p) => page.frontmatter.scope.some((s) => p === s || p.startsWith(`${s}/`)));
		if (touched.length === 0) continue;
		const body = opts.supplier({ rel: page.rel, kind: page.frontmatter.kind, scope: page.frontmatter.scope });
		if (body !== null) {
			// hand-edited 页面：追加复验小节而非重写
			updatePage(ws, page.rel, body, { title: page.frontmatter.title });
			refreshed.push(page.rel);
		} else {
			// 无供给：仅刷新 basedOn（视为人工确认现状）
			writePage(ws, {
				...page,
				frontmatter: { ...page.frontmatter, basedOn: head, updatedAt: new Date().toISOString() },
			});
			reviewed.push(page.rel);
		}
	}
	return { refreshed, reviewed };
}

/** confidence 衰减复验（08 §3.1：触及 scope 的未复验提交每条 −0.2） */
export function decayConfidence(ws: string): { decayed: { rel: string; confidence: number }[]; needsReview: string[] } {
	const head = gitHead(ws);
	const decayed: { rel: string; confidence: number }[] = [];
	const needsReview: string[] = [];
	for (const page of listPages(ws)) {
		if (page.frontmatter.scope.length === 0) continue;
		const commits = countCommitsSince(
			ws,
			page.frontmatter.basedOn ?? page.frontmatter.updatedAt,
			head,
			page.frontmatter.scope,
		);
		if (commits <= 0) continue;
		// 幂等语义：置信度 = 0.9 − 未复验提交数 × 0.2（每次重算，不叠加）
		const next = Math.max(0, Math.round((DEFAULT_CONFIDENCE - commits * DECAY_PER_COMMIT) * 10) / 10);
		writePage(ws, { ...page, frontmatter: { ...page.frontmatter, confidence: next } });
		decayed.push({ rel: page.rel, confidence: next });
		if (next < REVIEW_THRESHOLD) needsReview.push(page.rel);
	}
	return { decayed, needsReview };
}

// —— 倒排索引（08 §5）——

export interface InvertedIndex {
	/** term（小写词元）→ 页面 rel 列表 */
	postings: Record<string, string[]>;
	titles: Record<string, string>;
}

const TOKEN_RE = /[\p{L}\p{N}_-]+/gu;

function tokenize(text: string): string[] {
	return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 1);
}

export function buildIndex(pages: WikiPage[]): InvertedIndex {
	const postings: Record<string, string[]> = {};
	const titles: Record<string, string> = {};
	for (const p of pages) {
		titles[p.rel] = p.frontmatter.title;
		const terms = new Set([
			...tokenize(p.frontmatter.title),
			...tokenize(p.body),
			...p.frontmatter.scope.flatMap(tokenize),
		]);
		for (const t of terms) {
			if (postings[t] === undefined) postings[t] = [];
			postings[t]?.push(p.rel);
		}
	}
	return { postings, titles };
}

/** wiki_search：关键词召回 + 标题加权（语义索引为可选组件，后续接入同一接口） */
export function searchWiki(index: InvertedIndex, query: string, limit = 8): WikiSearchHit[] {
	const qs = tokenize(query);
	if (qs.length === 0) return [];
	const scores = new Map<string, number>();
	for (const q of qs) {
		for (const rel of index.postings[q] ?? []) {
			scores.set(rel, (scores.get(rel) ?? 0) + 1);
		}
	}
	const titleBoost = (rel: string): number => {
		const title = (index.titles[rel] ?? "").toLowerCase();
		return qs.some((q) => title.includes(q)) ? 2 : 0;
	};
	return [...scores.entries()]
		.map(([rel, base]) => ({ rel, score: base + titleBoost(rel) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((h) => ({
			rel: h.rel,
			title: index.titles[h.rel] ?? h.rel,
			kind: kindForRel(h.rel),
			score: h.score,
			snippet: `.wiki/${h.rel}`,
		}));
}

// —— git 工具 ——

function git(ws: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd: ws, encoding: "utf8" });
	return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

function gitHead(ws: string): string | undefined {
	return git(ws, ["rev-parse", "HEAD"]) || undefined;
}

function changedPaths(ws: string, since: string, head: string | undefined): string[] {
	if (head === undefined) return [];
	const out = git(ws, ["diff", "--name-only", since, head]);
	return out.length > 0 ? out.split("\n") : [];
}

function countCommitsSince(ws: string, since: string, head: string | undefined, scope: string[]): number {
	if (head === undefined || scope.length === 0) return 0;
	const out = git(ws, ["log", "--format=%H", `${since}..${head}`, "--", ...scope]);
	return out.length > 0 ? out.split("\n").length : 0;
}

function listSourceDirs(ws: string): { name: string }[] {
	if (!existsSync(ws)) return [];
	return readdirSync(ws, { withFileTypes: true })
		.filter(
			(e) => e.isDirectory() && !["node_modules", ".git", "dist", ".ponda", ".wiki", "__pycache__"].includes(e.name),
		)
		.map((e) => ({ name: e.name }))
		.sort((a, b) => (a.name < b.name ? -1 : 1));
}
