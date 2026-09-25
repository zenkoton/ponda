/**
 * AgentLoop：daemon 内驱动一个会话循环的可插拔抽象。
 * M4 提供 Echo/Scripted 实现（后台存活与 RPC 语义的可运行验证）；
 * P4 补丁（PATCHES.md）落地后替换为 fork 内 pi-agent-core 的真实循环。
 */

export interface Usage {
	input: number;
	output: number;
	costUsd: number;
}

export interface AgentTurnInput {
	/** 本轮用户消息 */
	userText: string;
	/** 会话已累计条目数（含本轮 user 条目） */
	entryCount: number;
}

export interface AgentTurnResult {
	assistantText: string;
	usage: Usage;
}

export interface AgentLoop {
	readonly name: string;
	/** 处理一轮（异步执行，daemon 不阻塞 RPC） */
	process(input: AgentTurnInput): Promise<AgentTurnResult>;
	/** 运行时元信息（TUI 状态行 04 §5.4：模型/思考强度/上下文窗口）；不支持则缺省 */
	runtimeInfo?(): { modelId: string; thinkingLevel: string; contextWindow: number };
	/** 切换思考强度（TUI Ctrl-T / 命令） */
	setThinkingLevel?(level: "off" | "low" | "medium" | "high"): void;
}

/** 回声循环：回复确认文本；用量随文本长度确定（测试可断言）。
 *  notice：演示模式提示（未配置模型时 daemon 回落本循环，首条回复前置告知） */
export class EchoAgentLoop implements AgentLoop {
	readonly name = "echo";
	private readonly notice?: string;
	private saidNotice = false;

	constructor(notice?: string) {
		this.notice = notice;
	}

	async process(input: AgentTurnInput): Promise<AgentTurnResult> {
		const output = input.userText.length;
		const prefix = this.notice !== undefined && !this.saidNotice ? `${this.notice}\n` : "";
		this.saidNotice = true;
		return {
			assistantText: `${prefix}echo(${input.entryCount}): ${input.userText}`,
			usage: {
				input: 16 + output,
				output: 8 + output,
				costUsd: Math.round((0.0004 + output * 0.00002) * 1e6) / 1e6,
			},
		};
	}
}

/** 脚本循环：按序返回预设回复（attach/detach 竞态类测试用） */
export class ScriptedAgentLoop implements AgentLoop {
	readonly name = "scripted";
	private i = 0;
	private readonly replies: string[];

	constructor(replies: string[]) {
		this.replies = replies;
	}

	async process(): Promise<AgentTurnResult> {
		const reply = this.replies[this.i] ?? "(done)";
		this.i++;
		return { assistantText: reply, usage: { input: 1, output: reply.length, costUsd: 0.0001 } };
	}
}
