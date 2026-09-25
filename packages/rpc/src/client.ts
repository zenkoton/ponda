/**
 * RpcClient：Unix domain socket 上的 JSON-RPC 客户端。
 * request 按 id 配对（带超时）；通知经 setNotificationHandler 回调。
 */
import { connect, type Socket } from "node:net";
import {
	decodeLine,
	encodeMessage,
	isRpcError,
	isRpcResponse,
	RpcErrorCode,
	type RpcNotification,
	type RpcRequest,
} from "./protocol.ts";

export class RpcTimeoutError extends Error {
	constructor(method: string, ms: number) {
		super(`rpc timeout: ${method} (${ms}ms)`);
		this.name = "RpcTimeoutError";
	}
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class RpcClient {
	private socket: Socket | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private notificationHandler: ((n: RpcNotification) => void) | null = null;
	private closed = false;

	async connect(socketPath: string, timeoutMs = 3000): Promise<void> {
		if (this.closed) throw new Error("client closed");
		await new Promise<void>((resolve, reject) => {
			const s = connect(socketPath, () => {
				clearTimeout(t);
				resolve();
			});
			const t = setTimeout(() => {
				s.destroy();
				reject(new Error(`connect timeout: ${socketPath}`));
			}, timeoutMs);
			s.once("error", (e) => {
				clearTimeout(t);
				reject(e);
			});
			s.once("close", () => clearTimeout(t));
			this.socket = s;
		});
		const sock = this.socket;
		if (sock === null) throw new Error("connect failed");
		sock.setEncoding("utf8");
		let buffer = "";
		sock.on("data", (chunk: string) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				this.handleLine(line);
				nl = buffer.indexOf("\n");
			}
		});
		sock.on("close", () => {
			this.failAllPending(new Error("connection closed"));
		});
		sock.on("error", () => {
			this.failAllPending(new Error("connection error"));
		});
	}

	setNotificationHandler(h: ((n: RpcNotification) => void) | null): void {
		this.notificationHandler = h;
	}

	private handleLine(line: string): void {
		if (line.trim().length === 0) return;
		const msg = decodeLine(line);
		if (msg === null) return;
		if (isRpcResponse(msg) || isRpcError(msg)) {
			const p = this.pending.get(msg.id);
			if (p === undefined) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.error !== undefined) {
				p.reject(new Error(msg.error.message));
			} else {
				p.resolve(msg.result);
			}
			return;
		}
		const candidate = msg as Partial<RpcNotification> & Partial<RpcRequest>;
		if (candidate.method !== undefined && candidate.id === undefined) {
			this.notificationHandler?.(msg as unknown as RpcNotification);
		}
	}

	request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
		if (this.closed) return Promise.reject(new Error("client closed"));
		const sock = this.socket;
		if (sock === null || sock.destroyed) return Promise.reject(new Error("not connected"));
		const id = this.nextId++;
		const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RpcTimeoutError(method, timeoutMs));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => resolve(v as T),
				reject,
				timer,
			});
			sock.write(`${encodeMessage(req)}\n`);
		});
	}

	private failAllPending(e: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(e);
		}
		this.pending.clear();
	}

	close(): void {
		this.closed = true;
		this.failAllPending(new Error("client closed"));
		this.socket?.destroy();
		this.socket = null;
	}

	get connected(): boolean {
		return this.socket !== null && !this.socket.destroyed;
	}
}

export { RpcErrorCode };
