import { RpcErrorCode, type RpcNotification } from "./protocol.ts";
export declare class RpcTimeoutError extends Error {
	constructor(method: string, ms: number);
}
export declare class RpcClient {
	private socket;
	private nextId;
	private readonly pending;
	private notificationHandler;
	private closed;
	connect(socketPath: string, timeoutMs?: number): Promise<void>;
	setNotificationHandler(h: ((n: RpcNotification) => void) | null): void;
	private handleLine;
	request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
	private failAllPending;
	close(): void;
	get connected(): boolean;
}
export { RpcErrorCode };
//# sourceMappingURL=client.d.ts.map
