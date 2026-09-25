import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	buildIndex,
	buildWiki,
	decayConfidence,
	listPages,
	parseFrontmatter,
	readPage,
	refreshWiki,
	searchWiki,
	serializePage,
	updatePage,
	wikiRoot,
} from "../src/wiki.ts";

const dirs: string[] = [];
function newWs(git = true): string {
	const d = mkdtempSync(join(tmpdir(), "ponda-wiki-"));
	dirs.push(d);
	mkdirSync(join(d, "src"), { recursive: true });
	writeFileSync(join(d, "src", "a.ts"), "export const a = 1;\n");
	if (git) {
		execFileSync("git", ["init", "-q"], { cwd: d });
		execFileSync("git", ["add", "-A"], { cwd: d });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c1"], { cwd: d });
	}
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function commit(ws: string, msg: string, paths: { p: string; content: string }[]): void {
	for (const { p, content } of paths) {
		const abs = join(ws, p);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, content);
	}
	execFileSync("git", ["add", "-A"], { cwd: ws });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], { cwd: ws });
}

test("frontmatter：解析与序列化往返", () => {
	const text = `---\ntitle: auth 模块\nkind: module\nscope: src/auth/, src/session\nupdatedAt: 2026-09-25T00:00:00Z\nbasedOn: abc123\nconfidence: 0.5\n---\n\n# auth\n`;
	const p = parseFrontmatter(text);
	assert.equal(p.frontmatter.title, "auth 模块");
	assert.deepEqual(p.frontmatter.scope, ["src/auth", "src/session"]);
	assert.equal(p.frontmatter.confidence, 0.5);
	const round = serializePage({ rel: "modules/auth.md", frontmatter: p.frontmatter, body: p.body });
	assert.ok(round.includes("scope: src/auth, src/session"));
	assert.ok(round.includes("confidence: 0.5"));
});

test("首次构建：骨架 + 模块页（供给方注入），目录规范符合 08 §2", () => {
	const ws = newWs();
	const r = buildWiki(ws, {
		moduleSupplier: (req) => (req.scope[0] === "src/" ? "# src 模块\n含 a.ts\n" : null),
	});
	assert.deepEqual(r.created.sort(), ["conventions.md", "glossary.md", "index.md", "modules/src.md"]);
	assert.ok(existsSync(join(wikiRoot(ws), "modules", "src.md")));
	const page = readPage(ws, "modules/src.md");
	assert.equal(page?.frontmatter.kind, "module");
	assert.equal(page?.frontmatter.confidence, 0.9);
	assert.ok((page?.frontmatter.basedOn ?? "").length >= 7, "basedOn 记录 git commit");
	// 幂等：重跑不重复创建
	const r2 = buildWiki(ws, { moduleSupplier: () => "x" });
	assert.deepEqual(r2.created, []);
});

test("增量更新：触及 scope 的页面复验，未触及不动", () => {
	const ws = newWs();
	buildWiki(ws, { moduleSupplier: (req) => (req.scope[0] === "src/" ? "v1" : null) });
	const before = readPage(ws, "modules/src.md");
	commit(ws, "改 src", [{ p: "src/a.ts", content: "export const a = 2;\n" }]);
	const r = refreshWiki(ws, { supplier: (req) => (req.rel === "modules/src.md" ? "v2 内容" : null) });
	assert.deepEqual(r.refreshed, ["modules/src.md"]);
	const after = readPage(ws, "modules/src.md");
	assert.ok(after?.body.includes("v2 内容"));
	assert.notEqual(after?.frontmatter.updatedAt, before?.frontmatter.updatedAt);
});

test("confidence 衰减：触及 scope 的提交每条 −0.2，低于 0.4 入待复验", () => {
	const ws = newWs();
	buildWiki(ws, { moduleSupplier: (req) => (req.scope[0] === "src/" ? "v1" : null) });
	commit(ws, "c2", [{ p: "src/a.ts", content: "2" }]);
	commit(ws, "c3", [{ p: "src/a.ts", content: "3" }]);
	const r = decayConfidence(ws);
	const src = r.decayed.find((d) => d.rel === "modules/src.md");
	assert.equal(src?.confidence, 0.5, "0.9 − 2×0.2");
	// 再来 2 条提交 → 0.1 < 0.4
	commit(ws, "c4", [{ p: "src/a.ts", content: "4" }]);
	commit(ws, "c5", [{ p: "src/a.ts", content: "5" }]);
	const r2 = decayConfidence(ws);
	assert.ok(r2.needsReview.includes("modules/src.md"));
	assert.equal(readPage(ws, "modules/src.md")?.frontmatter.confidence, 0.1);
});

test("倒排索引检索：词召回 + 标题加权", () => {
	const pages = [
		{
			rel: "modules/auth.md",
			frontmatter: {
				title: "认证模块",
				kind: "module" as const,
				scope: ["src/auth"],
				updatedAt: "t",
				confidence: 0.9,
			},
			body: "登录 session token 管理在这里",
		},
		{
			rel: "modules/api.md",
			frontmatter: {
				title: "api 网关",
				kind: "module" as const,
				scope: ["src/api"],
				updatedAt: "t",
				confidence: 0.9,
			},
			body: "路由与鉴权转发，token 校验",
		},
		{
			rel: "glossary.md",
			frontmatter: { title: "术语表", kind: "glossary" as const, scope: [], updatedAt: "t", confidence: 0.9 },
			body: "token：令牌",
		},
	];
	const idx = buildIndex(pages);
	const hits = searchWiki(idx, "token");
	assert.equal(hits.length, 3);
	assert.ok(
		hits.every((h) => h.score >= 1),
		"词召回命中",
	);
	// 标题加权：标题含 "api" 的页面排最前
	const apiHits = searchWiki(idx, "api");
	assert.equal(apiHits[0]?.rel, "modules/api.md");
	assert.ok((apiHits[0]?.score ?? 0) > 2, "标题加权");
	const titleHit = searchWiki(idx, "认证模块"); // 中文无分词：整词 token
	assert.equal(titleHit[0]?.rel, "modules/auth.md");
	assert.deepEqual(searchWiki(idx, "zzz不存在"), []);
});

test("wiki_update：hand-edited 页面追加小节，重置 confidence；普通页整页重写", () => {
	const ws = newWs();
	buildWiki(ws, { moduleSupplier: () => "v1" });
	// 人工编辑标记
	const page = readPage(ws, "modules/src.md")!;
	writeFileSync(
		join(wikiRoot(ws), "modules/src.md"),
		serializePage({ ...page, frontmatter: { ...page.frontmatter, handEdited: true, confidence: 0.3 } }),
	);
	const updated = updatePage(ws, "modules/src.md", "新增认知");
	assert.ok(updated.body.includes("## 更新（"), "追加小节");
	assert.ok(updated.body.includes("v1"), "保留原文");
	assert.equal(updated.frontmatter.confidence, 0.9);
	// 普通页
	const u2 = updatePage(ws, "glossary.md", "# 术语表\n\n- A: a\n");
	assert.ok(u2.body.includes("- A: a"));
	assert.ok(!u2.body.includes("## 更新（"));
});

test("listPages：递归收集 .wiki 下全部 md", () => {
	const ws = newWs();
	buildWiki(ws, { moduleSupplier: () => "x" });
	mkdirSync(join(wikiRoot(ws), "decisions"), { recursive: true });
	appendFileSync(join(wikiRoot(ws), "decisions", "0001.md"), "---\ntitle: d1\nkind: decision\n---\nbody\n");
	const rels = listPages(ws).map((p) => p.rel);
	assert.ok(rels.includes("decisions/0001.md"));
	assert.ok(rels.includes("index.md"));
});
