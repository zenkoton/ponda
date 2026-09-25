import assert from "node:assert/strict";
import { test } from "node:test";
import { batch, createEffect, createMemo, createRoot, createSignal, untrack } from "../src/signal.ts";

test("createSignal：读写与函数式更新", () => {
	const [get, set] = createSignal(1);
	assert.equal(get(), 1);
	set(2);
	assert.equal(get(), 2);
	set((prev) => prev + 10);
	assert.equal(get(), 12);
});

test("createEffect：依赖变化重跑；无依赖不重跑", () => {
	const [a, setA] = createSignal(1);
	const [b] = createSignal(100);
	let runs = 0;
	let seen = 0;
	createEffect(() => {
		runs++;
		seen = a() + untrack(() => b());
	});
	assert.equal(runs, 1);
	assert.equal(seen, 101);
	setA(5);
	assert.equal(runs, 2);
	assert.equal(seen, 105);
});

test("createEffect：清理函数在重跑前调用", () => {
	const [a, setA] = createSignal(0);
	const events: string[] = [];
	createEffect(() => {
		const v = a();
		events.push(`run:${v}`);
		return () => events.push(`cleanup:${v}`);
	});
	setA(1);
	assert.deepEqual(events, ["run:0", "cleanup:0", "run:1"]);
});

test("createMemo：缓存派生值，依赖不变不重算", () => {
	const [a, setA] = createSignal(2);
	let computes = 0;
	const doubled = createMemo(() => {
		computes++;
		return a() * 2;
	});
	assert.equal(doubled(), 4);
	assert.equal(doubled(), 4);
	assert.equal(computes, 1);
	setA(5);
	assert.equal(doubled(), 10);
	assert.equal(computes, 2);
});

test("memo → effect 链：memo 先于下游 effect 更新", () => {
	const [a, setA] = createSignal(1);
	const log: number[] = [];
	const memo = createMemo(() => a() + 1);
	createEffect(() => {
		log.push(memo());
	});
	assert.deepEqual(log, [2]);
	setA(10);
	assert.deepEqual(log, [2, 11]);
});

test("batch：合并写入只触发一轮 effect", () => {
	const [a, setA] = createSignal(1);
	const [b, setB] = createSignal(1);
	let runs = 0;
	createEffect(() => {
		void `${a()} ${b()}`;
		runs++;
	});
	assert.equal(runs, 1);
	batch(() => {
		setA(2);
		setB(3);
		assert.equal(runs, 1, "batch 内不 flush");
	});
	assert.equal(runs, 2);
});

test("createRoot：dispose 后 effect 不再触发", () => {
	const [a, setA] = createSignal(1);
	let runs = 0;
	const dispose = createRoot((d) => {
		createEffect(() => {
			void a();
			runs++;
		});
		return d;
	});
	assert.equal(runs, 1);
	setA(2);
	assert.equal(runs, 2);
	dispose();
	setA(3);
	assert.equal(runs, 2);
});

test("等值写入不触发 effect", () => {
	const [a, setA] = createSignal("x");
	let runs = 0;
	createEffect(() => {
		void a();
		runs++;
	});
	setA("x");
	assert.equal(runs, 1);
});
