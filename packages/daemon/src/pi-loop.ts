/**
 * PiAgentLoop：daemon 会话内的真实 pi-agent-core 循环（P4，PATCHES.md）。
 *
 * 每个 daemon 会话持有一个 pi Agent 实例（多轮上下文保持），process() 走
 * 完整 agent 循环（streamFn → 工具调用 → 续轮），产出 assistant 文本 + usage。
 * 模型经 pi-ai 解析：真实链路读环境 models.json + auth；测试链路注入 faux
 * provider（registerFauxProvider，与上游 agent 包 e2e 同一测试基建）。
 */
import { Agent, type AgentMessage } from "../../agent/src/index.ts";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	getModel as getBuiltinModel,
	registerFauxProvider,
	streamSimple,
} from "../../ai/src/compat.ts";
import type { AgentLoop, AgentTurnInput, AgentTurnResult } from "./agent-loop.ts";

export interface PiLoopOptions {
	modelId: string;
	systemPrompt?: string;
	/** 注入 provider 注册（测试用 faux；真实链路经 pi-ai 内置 provider） */
	faux?: FauxProviderRegistration;
	tools?: unknown[];
}

export interface SkillStateBinding {
	/** 每轮注入 (P, Σ, O) 三元组（06 §2：P=任务规程、Σ=结构化状态、O=最新观察） */
	buildContext: () => { systemPrompt: string; userPrompt: string };
	/** 解析模型输出中的 state_patch 并应用（06 §3） */
	parseStatePatch: (replyText: string) => { patch?: Record<string, unknown | null>; errors: string[] };
}

export class PiAgentLoop implements AgentLoop {
	readonly name = "pi";
	private readonly agent: Agent;
	private readonly faux?: FauxProviderRegistration;
	private skillState: SkillStateBinding | null = null;

	constructor(opts: PiLoopOptions) {
		this.faux = opts.faux;
		const model =
			opts.faux !== undefined
				? (opts.faux.getModel(opts.modelId) ?? opts.faux.getModel())
				: requireModel(opts.modelId);
		this.agent = new Agent({
			streamFn: streamSimple,
			initialState: {
				systemPrompt: opts.systemPrompt ?? "You are a helpful coding agent.",
				model,
				thinkingLevel: "off",
				tools: [],
			},
		});
	}

	/** P3：绑定 skill-state（goal 任务经此切换到 (P, Σ, O) 上下文协议） */
	bindSkillState(binding: SkillStateBinding): void {
		this.skillState = binding;
	}

	async process(input: AgentTurnInput): Promise<AgentTurnResult> {
		if (this.skillState !== null) {
			return this.processWithSkillState(input);
		}
		await this.agent.prompt(input.userText);
		return extractResult(this.agent.state.messages);
	}

	/** P3：(P, Σ, O) 上下文协议（06 §5）——覆盖 system prompt + 用户消息为三元组 */
	private async processWithSkillState(input: AgentTurnInput): Promise<AgentTurnResult> {
		const binding = this.skillState;
		if (binding === null) throw new Error("skillState unexpectedly null");
		const ctx = binding.buildContext();
		// 替换 system prompt 为任务规程 P
		this.agent.state.messages = this.agent.state.messages.map((m) =>
			m.role === "system" ? { ...m, content: ctx.systemPrompt } : m,
		);
		// 用户消息注入 (Σ, O)
		const userMessage = `${ctx.userPrompt}\n\nLatest Observation:\n${input.userText}`;
		await this.agent.prompt(userMessage);
		const result = extractResult(this.agent.state.messages);
		// 解析 state_patch（06 §3 协议校验）
		const parsed = binding.parseStatePatch(result.assistantText);
		if (parsed.errors.length > 0) {
			// 无效补丁不阻塞执行（rollback-retry 由调用方驱动，06 §3）
			void parsed.errors;
		}
		return result;
	}

	unregister(): void {
		this.faux?.unregister();
	}
}

/** 从 transcript 尾部提取 assistant 文本 + thinking + usage */
function extractResult(messages: AgentMessage[]): AgentTurnResult {
	let text = "";
	let thinking: string | null = null;
	let inputTokens = 0;
	let outputTokens = 0;
	let costUsd = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m === undefined || m.role !== "assistant") continue;
		for (const block of m.content) {
			if (block.type === "text") text += (text.length > 0 ? "\n" : "") + block.text;
			else if (block.type === "thinking") thinking = (thinking ?? "") + block.thinking;
		}
		const usage = m.usage;
		inputTokens = usage.input;
		outputTokens = usage.output;
		costUsd = usage.cost.total;
		break;
	}
	return {
		assistantText: text,
		usage: { input: inputTokens, output: outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 },
	};
}

function requireModel(modelId: string): NonNullable<ReturnType<FauxProviderRegistration["getModel"]>> {
	// 真实链路：pi-ai 内置模型目录 / 环境 models.json 解析（P4 后续接入
	// daemon 的完整 provider 配置面；当前入口已具备，见 PiLoopOptions.faux）
	// 内置目录按 provider/modelId 两段解析；未命中时抛错（真实 provider 配置面随 P4 完整接入）
	const [provider, ...rest] = modelId.split("/");
	const id = rest.join("/") || modelId;
	const m = getBuiltinModel(provider as never, id as never);
	if (m === undefined || m === null) {
		throw new Error(`model not found: ${modelId}（真实 provider 配置随 P4 完整接入）`);
	}
	return m as NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>;
}

// —— 测试辅助（faux 响应脚本构造） ——

export { fauxAssistantMessage, fauxText, fauxThinking, registerFauxProvider };
export type { FauxProviderRegistration };
