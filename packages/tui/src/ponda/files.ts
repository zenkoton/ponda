/**
 * 工作区文件树（左栏「文件」页签，design: 04-tui.md §4.2；M5 第二批）。
 * 逐级展开：expanded 集合控制层级；忽略 node_modules/.git/dist/.ponda。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { listPages, WIKI_DIR } from "../../../core/src/wiki.ts";

const IGNORE = new Set(["node_modules", ".git", "dist", ".ponda", ".wiki", "__pycache__"]);

export interface FileTreeNode {
	name: string;
	relPath: string;
	dir: boolean;
	depth: number;
}

export interface FileTreeState {
	root: string | null;
	expanded: Set<string>;
	/** 选中项（渲染行索引） */
	cursor: number;
}

export function newFileTreeState(): FileTreeState {
	return { root: null, expanded: new Set(), cursor: 0 };
}

/** 按展开状态扫描可渲染的树行（上限保护：maxRows） */
export function scanTree(root: string, expanded: Set<string>, maxRows = 200): FileTreeNode[] {
	const out: FileTreeNode[] = [];
	if (!existsSync(root)) return out;
	const walk = (dir: string, depth: number): void => {
		if (out.length >= maxRows) return;
		let entries: string[];
		try {
			entries = readdirSync(dir, { withFileTypes: true })
				.filter((e) => !IGNORE.has(e.name))
				.map((e) => e.name)
				.sort();
		} catch {
			return;
		}
		for (const name of entries) {
			if (out.length >= maxRows) return;
			const abs = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(abs).isDirectory();
			} catch {
				continue;
			}
			const rel = relative(root, abs);
			out.push({ name, relPath: rel, dir: isDir, depth });
			if (isDir && expanded.has(rel)) walk(abs, depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

function safeListWiki(root: string): { rel: string }[] {
	try {
		return listPages(root).map((p) => ({ rel: p.rel }));
	} catch {
		return [];
	}
}

/** @ 补全的扁平文件源（浅层优先 + .wiki 页面，数量上限） */
export function listFileCandidates(root: string | null, limit = 200): string[] {
	if (root === null || !existsSync(root)) return [];
	// .wiki 页面前缀（08 §4：@ 补全包含知识库页面）
	const wikiPages = safeListWiki(root).map((p) => `${WIKI_DIR}/${p.rel}`);
	const out: string[] = [...wikiPages];
	const walk = (dir: string, depth: number): void => {
		if (out.length >= limit || depth > 4) return;
		let names: string[];
		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((e) => !IGNORE.has(e.name))
				.map((e) => e.name)
				.sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (out.length >= limit) return;
			const abs = join(dir, name);
			let isDir = false;
			try {
				isDir = statSync(abs).isDirectory();
			} catch {
				continue;
			}
			out.push(relative(root, abs));
			if (isDir) walk(abs, depth + 1);
		}
	};
	walk(root, 0);
	return out;
}

/** 文件预览行（中栏文件页签；.md 由调用方走 Markdown） */
export function readFilePreview(
	path: string,
	maxLines = 400,
): { lines: string[]; markdown: boolean; truncated: boolean } {
	const markdown = path.endsWith(".md");
	let text = "";
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { lines: ["(无法读取)"], markdown: false, truncated: false };
	}
	const all = text.split("\n");
	const truncated = all.length > maxLines;
	const lines = (truncated ? all.slice(0, maxLines) : all).map((l, i) => `${String(i + 1).padStart(4)} │ ${l}`);
	return { lines, markdown, truncated };
}
