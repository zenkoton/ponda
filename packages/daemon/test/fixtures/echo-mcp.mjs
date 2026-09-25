/**
 * 测试用最小 MCP stdio server（ndjson JSON-RPC）：
 * initialize → tools/list（echo 工具）→ tools/call（回显 text 参数）
 */
import { readFileSync } from "node:fs";

const TOOLS = [
	{
		name: "echo",
		description: "Echo the text back",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "text to echo" } },
			required: ["text"],
		},
	},
];

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	const lines = buf.split("\n");
	buf = lines.pop() ?? "";
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		const reply = respond(msg);
		if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
	}
});

function respond(msg) {
	if (msg.method === "initialize") {
		return {
			jsonrpc: "2.0",
			id: msg.id,
			result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-mcp", version: "0.1.0" } },
		};
	}
	if (msg.method === "tools/list") {
		return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
	}
	if (msg.method === "tools/call") {
		const text = msg.params?.arguments?.text ?? "(empty)";
		return {
			jsonrpc: "2.0",
			id: msg.id,
			result: { content: [{ type: "text", text: `echo: ${text}` }], isError: false },
		};
	}
	return null; // notifications 等不回
}
