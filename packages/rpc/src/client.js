/**
 * RpcClient：Unix domain socket 上的 JSON-RPC 客户端。
 * request 按 id 配对（带超时）；通知经 setNotificationHandler 回调。
 */
import { connect } from "node:net";
import { decodeLine, encodeMessage, isRpcError, isRpcResponse, RpcErrorCode, } from "./protocol.js";
export class RpcTimeoutError extends Error {
    constructor(method, ms) {
        super(`rpc timeout: ${method} (${ms}ms)`);
        this.name = "RpcTimeoutError";
    }
}
export class RpcClient {
    socket = null;
    nextId = 1;
    pending = new Map();
    notificationHandler = null;
    closed = false;
    async connect(socketPath, timeoutMs = 3000) {
        if (this.closed)
            throw new Error("client closed");
        await new Promise((resolve, reject) => {
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
        if (sock === null)
            throw new Error("connect failed");
        sock.setEncoding("utf8");
        let buffer = "";
        sock.on("data", (chunk) => {
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
    setNotificationHandler(h) {
        this.notificationHandler = h;
    }
    handleLine(line) {
        if (line.trim().length === 0)
            return;
        const msg = decodeLine(line);
        if (msg === null)
            return;
        if (isRpcResponse(msg) || isRpcError(msg)) {
            const p = this.pending.get(msg.id);
            if (p === undefined)
                return;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error !== undefined) {
                p.reject(new Error(msg.error.message));
            }
            else {
                p.resolve(msg.result);
            }
            return;
        }
        const candidate = msg;
        if (candidate.method !== undefined && candidate.id === undefined) {
            this.notificationHandler?.(msg);
        }
    }
    request(method, params, timeoutMs = 10000) {
        if (this.closed)
            return Promise.reject(new Error("client closed"));
        const sock = this.socket;
        if (sock === null || sock.destroyed)
            return Promise.reject(new Error("not connected"));
        const id = this.nextId++;
        const req = { jsonrpc: "2.0", id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new RpcTimeoutError(method, timeoutMs));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (v) => resolve(v),
                reject,
                timer,
            });
            sock.write(`${encodeMessage(req)}\n`);
        });
    }
    failAllPending(e) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(e);
        }
        this.pending.clear();
    }
    close() {
        this.closed = true;
        this.failAllPending(new Error("client closed"));
        this.socket?.destroy();
        this.socket = null;
    }
    get connected() {
        return this.socket !== null && !this.socket.destroyed;
    }
}
export { RpcErrorCode };
//# sourceMappingURL=client.js.map