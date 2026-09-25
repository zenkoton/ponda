import assert from "node:assert/strict";
import { test } from "node:test";
import { box, rich } from "../src/element.ts";
import { DEFAULT_MD_THEME, markdownElements, parseInline, parseMarkdown } from "../src/markdown.ts";
import { renderTree } from "../src/paint.ts";

function renderPlain(elements: ReturnType<typeof markdownElements>, width = 60): string[] {
	return renderTree(box({ flexDirection: "column" }, elements), width, 200).map((l) =>
		l.replace(/\x1b\[[0-9;]*m/g, ""),
	);
}

test("parseMarkdown：标题/列表/代码块/引用/分割线", () => {
	const blocks = parseMarkdown("# T\n正文\n\n- a\n- b\n\n```\ncode\n```\n\n> 引用\n\n---");
	assert.deepEqual(
		blocks.map((b) => b.type),
		["heading", "paragraph", "listItem", "listItem", "code", "quote", "hr"],
	);
});

test("parseInline：粗体/行内代码/链接分段", () => {
	const spans = parseInline("a **b** `c` [d](http://e)", {}, DEFAULT_MD_THEME);
	assert.deepEqual(
		spans.map((s) => s.text),
		["a ", "b", " ", "c", " ", "d"],
	);
	assert.equal(spans[1]?.style?.bold, true);
	assert.equal(spans[3]?.style?.fg, "yellow");
	assert.equal(spans[5]?.style?.fg, "cyan");
});

test("markdownElements：标题加粗、列表带符号、表格渲染", () => {
	const md = "# 计划\n1. 抽接口\n2. 补测试\n\n| a | b |\n|---|---|\n| 1 | 2 |";
	const lines = renderPlain(markdownElements(md));
	assert.ok(lines.some((l) => l.includes("计划")));
	assert.ok(lines.some((l) => l.includes("1. 抽接口")));
	assert.ok(lines.some((l) => l.includes("2. 补测试")));
	assert.ok(lines.some((l) => l.includes("a")));
	assert.ok(lines.some((l) => l.includes(" 1 ")));
});

test("markdownElements：混合样式段落换行后样式保留", () => {
	const lines = renderTree(
		box({ flexDirection: "column", height: 2 }, [rich(parseInline("**bold** and plain tail", {}, DEFAULT_MD_THEME))]),
		12,
		2,
	);
	const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
	assert.deepEqual(plain, ["bold and", "plain tail"]);
	// 第一行应包含粗体 SGR
	assert.ok(lines[0]?.includes("\x1b[1m"), `首行含粗体：${JSON.stringify(lines[0])}`);
});
