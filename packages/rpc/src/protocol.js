/**
 * 线协议：NDJSON 帧（一行一个 JSON 对象）上的 JSON-RPC 2.0 子集（design: 05-runtime.md §5.3）。
 * 请求/响应按 id 配对；事件经 notification（无 id）推送。
 */
export const RpcErrorCode = {
    methodNotFound: -32601,
    invalidParams: -32602,
    internal: -32603,
    timeout: -32000,
    shutdown: -32001,
};
/** daemon 对外方法名（05 §5.3 接口表 + daemon 管理） */
export const Methods = {
    daemonPing: "daemon.ping",
    daemonShutdown: "daemon.shutdown",
    sessionList: "session.list",
    sessionNew: "session.new",
    sessionAttach: "session.attach",
    sessionDetach: "session.detach",
    sessionSend: "session.send",
    permissionRespond: "permission.respond",
    costSnapshot: "cost.snapshot",
    taskStatus: "task.status",
    taskStart: "task.start",
    taskConfirm: "task.confirm",
    taskReplan: "task.replan",
    taskVerify: "task.verify",
    taskSettle: "task.settle",
    taskClose: "task.close",
    taskCancel: "task.cancel",
    taskChangeRequest: "task.change_request",
    taskApproveChange: "task.approve_change",
    swarmSpawn: "swarm.spawn",
    swarmStatus: "swarm.status",
    swarmCancel: "swarm.cancel",
    swarmSend: "swarm.send",
    swarmRead: "swarm.read",
    wikiSearch: "wiki.search",
    wikiRead: "wiki.read",
    wikiUpdate: "wiki.update",
    wikiBuild: "wiki.build",
    wikiRefresh: "wiki.refresh",
};
/** daemon → 客户端的通知（session.events 流等） */
export const Notifications = {
    sessionEvents: "session.events",
    permissionRequest: "permission.request",
    taskEvents: "task.events",
    swarmEvents: "swarm.events",
};
// —— 解码/判定 ——
export function isRpcRequest(m) {
    return m.method !== undefined && m.id !== undefined;
}
export function isRpcResponse(m) {
    return m.id !== undefined && m.result !== undefined;
}
export function isRpcError(m) {
    return m.id !== undefined && m.error !== undefined;
}
export function isRpcNotification(m) {
    const candidate = m;
    return candidate.method !== undefined && candidate.id === undefined;
}
/** 解码一行；坏行返回 null（调用方跳过） */
export function decodeLine(line) {
    try {
        const v = JSON.parse(line);
        if (typeof v !== "object" || v === null)
            return null;
        return v;
    }
    catch {
        return null;
    }
}
export function encodeMessage(m) {
    return JSON.stringify(m);
}
//# sourceMappingURL=protocol.js.map