import assert from "node:assert/strict";
import { test } from "node:test";
import { box, text } from "../src/element.ts";
import { Screen } from "../src/screen.ts";
import { batch, createSignal } from "../src/signal.ts";
import { CountingTerminal, VirtualTerminal } from "./virtual-terminal.ts";

test("Screen：首帧全量、信号变化只写变更行", async () => {
	const [label, setLabel] = createSignal("aaa");
	const term = new VirtualTerminal(20, 3);
	const frames: string[][] = [];
	const screen = new Screen({
		terminal: term,
		root: () => box({ flexDirection: "column" }, [text({ text: label() }), text({ text: "bbb" })]),
		onFrame: (lines) => frames.push(lines),
	});
	screen.start();
	await new Promise((r) => setTimeout(r, 10));
	const fullBytes = term.writtenBytes();
	assert.ok(fullBytes > 0);
	assert.equal(frames.length, 1);
	assert.equal(frames[0]?.length, 3);

	const before = term.writtenBytes();
	setLabel("ccc");
	await new Promise((r) => setTimeout(r, 10));
	const delta = term.writtenBytes() - before;
	assert.ok(delta < fullBytes * 0.6, `增量写出 ${delta} 应小于首帧 ${fullBytes}`);
	assert.equal(frames.length, 2);
	assert.equal(frames[1]?.[0], frames[0]?.[0]?.replace("aaa", "ccc"));
	screen.stop();
});

test("Screen：等值信号写入不产生新帧", async () => {
	const [n, setN] = createSignal(1);
	const term = new VirtualTerminal(10, 2);
	const frames: string[][] = [];
	const screen = new Screen({
		terminal: term,
		root: () => box({ flexDirection: "column" }, [text({ text: `n=${n()}` })]),
		onFrame: (lines) => frames.push(lines),
	});
	screen.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 1);
	setN(1);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 1);
	screen.stop();
});

test("Screen：batch 内多次写入合并为单帧", async () => {
	const [a, setA] = createSignal("a");
	const [b, setB] = createSignal("b");
	const term = new VirtualTerminal(20, 2);
	const frames: string[][] = [];
	const screen = new Screen({
		terminal: term,
		root: () => box({ flexDirection: "row" }, [text({ text: `${a()}${b()}` })]),
		onFrame: (lines) => frames.push(lines),
	});
	screen.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 1);
	batch(() => {
		setA("x");
		setB("y");
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 2, `batch 合并为单帧：实际 ${frames.length}`);
	screen.stop();
});

test("Screen：resize 触发全量重绘", async () => {
	const term = new VirtualTerminal(20, 3);
	const frames: string[][] = [];
	const screen = new Screen({
		terminal: term,
		root: () => box({ flexDirection: "column" }, [text({ text: "fixed" })]),
		onFrame: (lines) => frames.push(lines),
	});
	screen.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames[0]?.length, 3);
	term.resize(30, 5);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(frames.length, 2);
	assert.equal(frames[1]?.length, 5);
	screen.stop();
});

test("Screen：差分写出远小于整帧（CountingTerminal 证据）", async () => {
	const [v, setV] = createSignal("x");
	const inner = new VirtualTerminal(80, 24);
	const term = new CountingTerminal(inner);
	const screen = new Screen({
		terminal: term,
		root: () =>
			box({ flexDirection: "column" }, [
				text({ text: `value=${v()}` }),
				...Array.from({ length: 22 }, (_, i) => text({ text: `row ${i} ${"z".repeat(40)}` })),
			]),
	});
	screen.start();
	await new Promise((r) => setTimeout(r, 10));
	const full = term.bytes;
	assert.ok(full > 1000, `整帧体量：${full}`);
	const before = term.bytes;
	setV("y");
	await new Promise((r) => setTimeout(r, 10));
	const delta = term.bytes - before;
	assert.ok(delta < full * 0.25, `增量 ${delta} ≪ 整帧 ${full}`);
	screen.stop();
});
