/**
 * RpcServer：Unix domain socket 上的 JSON-RPC 服务端（design: 05 §5.3）。
 * 每连接独立行缓冲；dispatch 抛错转 error 响应；支持向筛选后的连接广播通知。
 */

import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import {
	decodeLine,
	encodeMessage,
	isRpcRequest,
	RpcErrorCode,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
} from "./protocol.ts";

export interface RpcConnection {
	id: number;
	notify(method: string, params?: Record<string, unknown>): void;
	destroy(): void;
}

export type Dispatch = (req: RpcRequest, conn: RpcConnection) => Promise<unknown> | unknown;

export class RpcServer {
	private server: Server | null = null;
	private nextConnId = 1;
	readonly connections: RpcConnection[] = [];
	/** 连接建立/断开钩子（daemon 维护 attach 表） */
	onConnectionChange: ((conn: RpcConnection, up: boolean) => void) | null = null;
	private readonly dispatch: Dispatch;

	constructor(dispatch: Dispatch) {
		this.dispatch = dispatch;
	}

	async listen(socketPath: string): Promise<void> {
		if (existsSync(socketPath)) rmSync(socketPath); // 陈旧 socket 文件
		this.server = createServer((socket: Socket) => this.handleSocket(socket));
		await new Promise<void>((resolve, reject) => {
			const s = this.server;
			if (s === null) return reject(new Error("server not created"));
			s.once("error", reject);
			s.listen(socketPath, () => {
				s.off("error", reject);
				resolve();
			});
		});
	}

	private handleSocket(socket: Socket): void {
		const connId = this.nextConnId++;
		const conn: RpcConnection = {
			id: connId,
			notify: (method, params) => {
				const n: RpcNotification = { jsonrpc: "2.0", method, params };
				this.writeLine(socket, encodeMessage(n));
			},
			destroy: () => socket.destroy(),
		};
		this.connections.push(conn);
		this.onConnectionChange?.(conn, true);

		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let nl = buffer.indexOf("\n");
			while (nl >= 0) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				this.handleLine(line, socket, conn);
				nl = buffer.indexOf("\n");
			}
		});
		const drop = () => {
			const i = this.connections.indexOf(conn);
			if (i >= 0) this.connections.splice(i, 1);
			this.onConnectionChange?.(conn, false);
		};
		socket.on("close", drop);
		socket.on("error", drop);
	}

	private handleLine(line: string, socket: Socket, conn: RpcConnection): void {
		if (line.trim().length === 0) return;
		const msg = decodeLine(line);
		if (msg === null || !isRpcRequest(msg)) return; // 服务端不处理响应/坏行

		void (async () => {
			const res: RpcResponse = { jsonrpc: "2.0", id: msg.id };
			try {
				res.result = await this.dispatch(msg, conn);
			} catch (e) {
				res.result = undefined;
				res.error = {
					code: RpcErrorCode.internal,
					message: e instanceof Error ? e.message : String(e),
				};
			}
			this.writeLine(socket, encodeMessage(res));
		})();
	}

	private writeLine(socket: Socket, line: string): void {
		if (!socket.destroyed) socket.write(`${line}\n`);
	}

	/** 向筛选后的连接广播通知 */
	broadcast(method: string, params?: Record<string, unknown>, filter?: (conn: RpcConnection) => boolean): void {
		for (const conn of this.connections) {
			if (filter && !filter(conn)) continue;
			conn.notify(method, params);
		}
	}

	async close(): Promise<void> {
		const s = this.server;
		if (s === null) return;
		// 先断开全部连接（否则 server.close 回调会等待连接自然结束 → 死锁）
		for (const conn of [...this.connections]) conn.destroy();
		await new Promise<void>((resolve) => s.close(() => resolve()));
		this.server = null;
	}
}
