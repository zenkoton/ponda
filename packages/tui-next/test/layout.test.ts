import assert from "node:assert/strict";
import { test } from "node:test";
import { box, modal, scroll, text } from "../src/element.ts";
import { layout } from "../src/layout.ts";
import { renderTree } from "../src/paint.ts";

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

test("layout：column 栈按 auto 高度堆叠", () => {
	const root = box({ flexDirection: "column" }, [text({ text: "a" }), text({ text: "b" })]);
	const node = layout(root, 10);
	assert.equal(node.h, 2);
	assert.deepEqual(
		(node.children ?? []).map((c) => c.y),
		[0, 1],
	);
});

test("layout：row 主轴 grow 分配 + 固定宽", () => {
	const root = box({ flexDirection: "row", width: 20 }, [
		box({ width: 5 }, [text({ text: "L" })]),
		box({ grow: 1 }, [text({ text: "C" })]),
		box({ width: 5 }, [text({ text: "R" })]),
	]);
	const node = layout(root, 20);
	const widths = (node.children ?? []).map((c) => c.w);
	assert.deepEqual(widths, [5, 10, 5]);
	const xs = (node.children ?? []).map((c) => c.x);
	assert.deepEqual(xs, [0, 5, 15]);
});

test("layout：百分比宽度", () => {
	const root = box({ flexDirection: "row", width: 100 }, [box({ width: "28%" }, []), box({ grow: 1 }, [])]);
	const node = layout(root, 100);
	assert.deepEqual(
		(node.children ?? []).map((c) => c.w),
		[28, 72],
	);
});

test("layout：overflow 按 shrink 收缩且 min 钳制", () => {
	const root = box({ flexDirection: "column", height: 10 }, [
		box({ height: 6 }, []),
		box({ height: 6, shrink: 2, minHeight: 3 }, []),
		box({ height: 6, shrink: 1 }, []),
	]);
	const node = layout(root, 40, 10);
	const heights = (node.children ?? []).map((c) => c.h);
	assert.equal(
		heights.reduce((a, b) => a + b, 0),
		10,
	);
	assert.ok((heights[1] ?? 0) >= 3, `shrink 后不低于 min：${heights}`);
});

test("layout：文本按宽度换行决定高度", () => {
	const node = layout(text({ text: "abcdefghij" }), 4);
	assert.equal(node.h, 3);
	assert.deepEqual(
		(node.textLines ?? []).map((l) => l.segments[0]?.text),
		["abcd", "efgh", "ij"],
	);
});

test("layout：CJK 宽字符占 2 列并对齐换行", () => {
	const node = layout(text({ text: "中文abc" }), 4);
	assert.deepEqual(
		(node.textLines ?? []).map((l) => l.segments[0]?.text),
		["中文", "abc"],
	);
});

test("renderTree：行数 = 高度；边框绘制；modal 居中合成", () => {
	const root = box({ flexDirection: "column", height: 8 }, [
		box({ border: true, height: 3 }, [text({ text: "hi" })]),
		text({ text: "foot" }),
		modal({ width: 7, border: true }, [text({ text: "M" })]),
	]);
	const lines = renderTree(root, 12, 8).map(stripAnsi);
	assert.equal(lines.length, 8);
	assert.ok(lines[0]?.startsWith("┌"));
	assert.ok(lines[1]?.includes("hi"));
	// modal 宽 7 居中：x = floor((12-7)/2) = 2；高 3 居中：y = floor((8-3)/2) = 2
	assert.equal(lines[2]?.indexOf("┌"), 2, `modal 框水平居中：${lines[2]}`);
	assert.ok(lines[3]?.includes("M"));
});

test("renderTree：样式分段序列化且行尾复位", () => {
	const lines = renderTree(
		box({ flexDirection: "row", height: 1 }, [text({ text: "red", fg: "red" }), text({ text: "plain" })]),
		20,
		1,
	);
	assert.equal(lines.length, 1);
	assert.ok(lines[0]?.includes("\x1b[31mred"));
	assert.ok(lines[0]?.includes("red\x1b[0mplain"), `样式段间复位：${JSON.stringify(lines[0])}`);
	assert.equal((lines[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "").trimEnd(), "redplain");
});

test("renderTree：宽字符不越界", () => {
	const lines = renderTree(box({ height: 1 }, [text({ text: "中中中" })]), 5, 1).map(stripAnsi);
	assert.equal((lines[0] ?? "").trimEnd(), "中中");
});

test("scroll：offset 距底部滚动并裁剪到视口", () => {
	const render = (offset: number): string[] =>
		renderTree(box({ height: 2 }, [scroll(() => offset, [text({ text: "a\nb\nc\nd" })])]), 10, 2).map((l) =>
			stripAnsi(l).trimEnd(),
		);
	// 内容 4 行，视口 2 行：offset 0 → 末 2 行（c/d）；offset 1 → b/c；offset 过大钳制 → a/b
	assert.deepEqual(render(0), ["c", "d"]);
	assert.deepEqual(render(1), ["b", "c"]);
	assert.deepEqual(render(99), ["a", "b"]);
});

test("scroll：内容不足视口时不偏移", () => {
	const lines = renderTree(box({ height: 3 }, [scroll(() => 2, [text({ text: "x" })])]), 10, 3).map((l) =>
		stripAnsi(l).trimEnd(),
	);
	assert.equal(lines[0], "x");
});
