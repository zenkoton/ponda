/**
 * solid 风格细粒度响应式核心（opencode TUI 范式移植，对应 solid-js 的信号层）。
 *
 * 语义对齐 solid-js：
 * - `createSignal`：叶子状态；读取发生在 memo/effect 内时自动建立依赖。
 * - `createMemo`：派生值；依赖变化时按拓扑层级先于下游 effect 重算并缓存。
 * - `createEffect`：副作用；依赖变化时重新执行，返回的清理函数在下一次执行前调用。
 * - `batch`：合并多次写入，flush 只产生一轮重算（RPC 事件成批落地 → 单次渲染）。
 * - `untrack`：隔离依赖收集；`onCleanup`/`createRoot`：生命周期与释放。
 *
 * 实现为 eager 通知 + 按层级排序的同步 flush；图规模小（终端 UI 量级），
 * 不需要 solid 的 lazy glide 标记。排序键 (level, seq)：level 为创建深度，
 * seq 为全局创建序号——数据流上游必然先创建，因此重算顺序稳定。
 */

interface SignalNode {
	value: unknown;
	subs: Set<Computation>;
}

interface Computation {
	kind: "memo" | "effect";
	fn: () => unknown;
	/** memo 的输出信号（effect 无） */
	node?: SignalNode;
	value: unknown;
	sources: Set<SignalNode>;
	level: number;
	seq: number;
	queued: boolean;
	disposed: boolean;
	/** 本轮 effect 运行期间注册的清理函数（solid：fn 可返回清理函数，onCleanup 注册到运行中的计算） */
	cleanups: (() => void)[];
}

let activeComputation: Computation | null = null;
let creationDepth = 0;
let creationSeq = 0;
let batchDepth = 0;
let flushing = false;
const queue: Computation[] = [];

/** 手动释放区（Screen.stop 用）：收集区内注册的 onCleanup 与创建的计算 */
export interface ReactiveRoot {
	dispose(): void;
}

const rootCleanups = new WeakMap<ReactiveRoot, (() => void)[]>();
const rootComputations = new WeakMap<ReactiveRoot, Computation[]>();

export function createRoot<T>(fn: (dispose: () => void) => T): T {
	const cleanups: (() => void)[] = [];
	const computations: Computation[] = [];
	let disposed = false;
	const root: ReactiveRoot = {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const computation of computations.splice(0)) {
				computation.disposed = true;
				for (const source of computation.sources) source.subs.delete(computation);
				computation.sources.clear();
				for (const cleanup of computation.cleanups.splice(0)) runCleanup(cleanup);
			}
			const fns = cleanups.splice(0);
			for (const cleanup of fns) runCleanup(cleanup);
		},
	};
	rootCleanups.set(root, cleanups);
	rootComputations.set(root, computations);
	const prevActive = activeComputation;
	activeComputation = null;
	try {
		return withRootOwner(root, () => fn(() => root.dispose()));
	} finally {
		activeComputation = prevActive;
	}
}

export function onCleanup(fn: () => void): void {
	if (activeComputation !== null) {
		activeComputation.cleanups.push(fn);
		return;
	}
	const owner = currentRootOwner;
	if (owner !== null) {
		rootCleanups.get(owner)?.push(fn);
	}
}

/** createRoot 回调执行期间的隐式 owner（onCleanup 兜底挂载点） */
let currentRootOwner: ReactiveRoot | null = null;

function withRootOwner<T>(root: ReactiveRoot, fn: () => T): T {
	const prev = currentRootOwner;
	currentRootOwner = root;
	try {
		return fn();
	} finally {
		currentRootOwner = prev;
	}
}

export function createSignal<T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void] {
	const node: SignalNode = { value: initial, subs: new Set() };
	const get = (): T => {
		if (activeComputation !== null) {
			node.subs.add(activeComputation);
			activeComputation.sources.add(node);
		}
		return node.value as T;
	};
	const set = (next: T | ((prev: T) => T)): void => {
		const value = typeof next === "function" ? (next as (prev: T) => T)(node.value as T) : next;
		if (Object.is(value, node.value)) return;
		node.value = value;
		for (const sub of [...node.subs]) markDirty(sub);
		scheduleFlush();
	};
	return [get, set];
}

export function createMemo<T>(fn: () => T): () => T {
	const node: SignalNode = { value: undefined, subs: new Set() };
	let initialized = false;
	const computation: Computation = {
		kind: "memo",
		fn: (): T => fn(),
		node,
		value: undefined,
		sources: new Set(),
		level: creationDepth,
		seq: creationSeq++,
		queued: false,
		disposed: false,
		cleanups: [],
	};
	registerRootComputation(computation);
	const get = (): T => {
		if (!initialized && !computation.disposed) {
			// 首读时立即求值，保证下游拿到真值并建立传递依赖
			runMemo(computation);
			initialized = true;
		}
		if (activeComputation !== null) {
			node.subs.add(activeComputation);
			activeComputation.sources.add(node);
		}
		return node.value as T;
	};
	return get;
}

export function createEffect(fn: () => unknown): void {
	const computation: Computation = {
		kind: "effect",
		fn,
		value: undefined,
		sources: new Set(),
		level: creationDepth,
		seq: creationSeq++,
		queued: false,
		disposed: false,
		cleanups: [],
	};
	registerRootComputation(computation);
	runEffect(computation);
}

/** root 区内创建的计算记入 root，dispose 时统一拆除订阅 */
function registerRootComputation(computation: Computation): void {
	if (currentRootOwner !== null) {
		rootComputations.get(currentRootOwner)?.push(computation);
	}
}

export function untrack<T>(fn: () => T): T {
	const prev = activeComputation;
	activeComputation = null;
	try {
		return fn();
	} finally {
		activeComputation = prev;
	}
}

export function batch<T>(fn: () => T): T {
	batchDepth++;
	try {
		return fn();
	} finally {
		batchDepth--;
		if (batchDepth === 0 && !flushing) flush();
	}
}

function markDirty(computation: Computation): void {
	if (computation.disposed || computation.queued) return;
	computation.queued = true;
	queue.push(computation);
}

function scheduleFlush(): void {
	if (batchDepth > 0 || flushing) return;
	flush();
}

function flush(): void {
	flushing = true;
	try {
		while (queue.length > 0) {
			queue.sort((a, b) => a.level - b.level || a.seq - b.seq);
			const computation = queue.shift();
			if (computation === undefined || computation.disposed || !computation.queued) continue;
			computation.queued = false;
			if (computation.kind === "memo") runMemo(computation);
			else runEffect(computation);
		}
	} finally {
		flushing = false;
	}
}

function runMemo(computation: Computation): void {
	const prev = activeComputation;
	activeComputation = computation;
	const prevDepth = creationDepth;
	creationDepth = computation.level + 1;
	const prevSources = computation.sources;
	computation.sources = new Set();
	try {
		const value = computation.fn();
		computation.value = value;
		const node = computation.node;
		if (node !== undefined && !Object.is(value, node.value)) {
			node.value = value;
			for (const sub of [...node.subs]) markDirty(sub);
		}
	} finally {
		for (const source of prevSources) {
			if (!computation.sources.has(source)) source.subs.delete(computation);
		}
		creationDepth = prevDepth;
		activeComputation = prev;
	}
}

function runEffect(computation: Computation): void {
	for (const cleanup of computation.cleanups.splice(0)) runCleanup(cleanup);
	const prev = activeComputation;
	activeComputation = computation;
	const prevDepth = creationDepth;
	creationDepth = computation.level + 1;
	const prevSources = computation.sources;
	computation.sources = new Set();
	try {
		const result = computation.fn();
		if (typeof result === "function") computation.cleanups.push(result as () => void);
	} finally {
		for (const source of prevSources) {
			if (!computation.sources.has(source)) source.subs.delete(computation);
		}
		creationDepth = prevDepth;
		activeComputation = prev;
	}
}

function runCleanup(fn: () => void): void {
	try {
		fn();
	} catch (error) {
		// 清理失败不阻断其余释放
		console.error("cleanup error:", error);
	}
}

export { withRootOwner };
