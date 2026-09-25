/**
 * PiAgentLoop：daemon 会话内的真实 pi-agent-core 循环（P4，PATCHES.md）。
 *
 * 每个 daemon 会话持有一个 pi Agent 实例（多轮上下文保持），process() 走
 * 完整 agent 循环（streamFn → 工具调用 → 续轮），产出 assistant 文本 + usage。
 * 模型经 pi-ai 解析：真实链路读环境 models.json + auth；测试链路注入 faux
 * provider（registerFauxProvider，与上游 agent 包 e2e 同一测试基建）。
 */
import { Agent, type AgentMessage, type AgentTool } from "../../agent/src/index.ts";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getModel as getBuiltinModel,
	type Model,
	registerFauxProvider,
	streamSimple,
} from "../../ai/src/compat.ts";
import type { AgentLoop, AgentTurnInput, AgentTurnResult } from "./agent-loop.ts";

export interface PiLoopOptions {
	modelId: string;
	/** 直接传入已解析的模型目录项（model-config 解析环境 models.json 时使用；优先于 modelId） */
	model?: Model<any>;
	systemPrompt?: string;
	/** 注入 provider 注册（测试用 faux；真实链路经 pi-ai 内置 provider） */
	faux?: FauxProviderRegistration;
	/** 会话可用工具（read/bash/edit/write 等，createCodingTools 产物） */
	tools?: AgentTool<any>[];
	/** 按 provider 解析 API key（$ENV / !command / 明文，02 §6.1 ProviderDef 语义） */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 会话 id（telemetry 信封用） */
	sessionId?: string;
	/** skill-state 协议埋点（07 §2：state.patch / compaction） */
	onStateEvent?: (type: "state.patch" | "compaction", payload: Record<string, unknown>) => void;
	/** 工具执行事件（04 §5.3 折叠行数据源：name/摘要/成败/耗时） */
	onToolEvent?: (e: { name: string; argsDigest: string; ok: boolean; durationMs: number }) => void;
	/** 轮次结束钩子（03 §5.2：模式 A 快照链触发点 auto: turn <n>） */
	onTurnEnd?: (turn: number) => void;
}

export interface SkillStateBinding {
	/** 每轮注入 (P, Σ, O) 三元组（06 §2：P=任务规程、Σ=结构化状态、O=最新观察） */
	buildContext: () => { systemPrompt: string; userPrompt: string };
	/** 解析模型输出中的 state_patch（06 §3 协议校验） */
	parseStatePatch: (replyText: string) => { patch?: Record<string, unknown | null>; errors: string[] };
	/** 应用补丁（06 §3：整体状态校验归属运行时；返回错误同样触发 rollback-retry） */
	applyPatch?: (patch: Record<string, unknown | null>) => { ok: boolean; errors: string[] };
	/** 降级通知（06 §7：连续无效补丁超限回退完整历史） */
	onDegraded?: (reason: string) => void;
}

/** state_patch 无效时注入的重试提示（06 §3："当前状态为 Σ_t，请重新输出完整补丁"） */
const MAX_PATCH_RETRIES = 3;

export interface ToolGuardDecision {
	allowed: boolean;
	reason: string;
	/** 改写后的入参（原地合并进循环已验证的 args 对象——上游不提供返回值改写通道） */
	rewritten?: Record<string, unknown>;
}

export interface ToolGuard {
	/** 工具调用前拦截（03 §7.1：路由/重写/拒绝）；可异步（权限申请往返） */
	beforeToolCall?: (call: {
		name: string;
		arguments: Record<string, unknown>;
	}) => ToolGuardDecision | Promise<ToolGuardDecision>;
	/** 工具调用后记录（telemetry/审计） */
	afterToolCall?: (
		call: { name: string; arguments: Record<string, unknown> },
		result: { ok: boolean; durationMs: number },
	) => void;
}

export class PiAgentLoop implements AgentLoop {
	readonly name = "pi";
	private readonly agent: Agent;
	private readonly onStateEvent?: (type: "state.patch" | "compaction", payload: Record<string, unknown>) => void;
	private readonly faux?: FauxProviderRegistration;
	private skillState: SkillStateBinding | null = null;
	private toolGuard: ToolGuard | null = null;

	constructor(opts: PiLoopOptions) {
		this.faux = opts.faux;
		this.onStateEvent = opts.onStateEvent;
		const model =
			opts.faux !== undefined
				? (opts.faux.getModel(opts.modelId) ?? opts.faux.getModel())
				: (opts.model ?? requireModel(opts.modelId));
		this.agent = new Agent({
			streamFn: streamSimple,
			getApiKey: opts.getApiKey,
			initialState: {
				systemPrompt: opts.systemPrompt ?? "You are a helpful coding agent.",
				model,
				thinkingLevel: "off",
				tools: opts.tools ?? [],
			},
		});
		const wantTurnEnd = opts.onTurnEnd !== undefined;
		if (opts.onToolEvent !== undefined || wantTurnEnd) {
			let turnCount = 0;
			const started = new Map<string, { name: string; argsDigest: string; at: number }>();
			this.agent.subscribe((event) => {
				if (event.type === "turn_end") {
					turnCount++;
					opts.onTurnEnd?.(turnCount);
					return Promise.resolve();
				}
				if (event.type === "tool_execution_start") {
					started.set(event.toolCallId, {
						name: event.toolName,
						argsDigest: JSON.stringify(event.args ?? {}).slice(0, 80),
						at: Date.now(),
					});
				} else if (event.type === "tool_execution_end") {
					const st = started.get(event.toolCallId);
					started.delete(event.toolCallId);
					if (st !== undefined) {
						opts.onToolEvent?.({
							name: st.name,
							argsDigest: st.argsDigest,
							ok: !event.isError,
							durationMs: Date.now() - st.at,
						});
					}
				}
				return Promise.resolve();
			});
		}
	}

	/** P3：绑定 skill-state（goal 任务经此切换到 (P, Σ, O) 上下文协议） */
	bindSkillState(binding: SkillStateBinding): void {
		this.skillState = binding;
	}

	/** sandbox-guard：绑定工具守卫（03 §7.1 路由/重写/拒绝） */
	bindToolGuard(guard: ToolGuard): void {
		this.toolGuard = guard;
		this.agent.beforeToolCall = async (context) => {
			const before = this.toolGuard?.beforeToolCall;
			if (before === undefined) return undefined;
			const decision = await before({
				name: context.toolCall.name,
				arguments: (context.args ?? {}) as Record<string, unknown>,
			});
			if (!decision.allowed) {
				return { block: true, reason: decision.reason };
			}
			if (decision.rewritten !== undefined) {
				// 上游 BeforeToolCallResult 无入参改写通道：context.args 与后续执行的
				// prepared.args 是同一对象，原地合并即生效（agent-loop.ts prepareToolCall）
				for (const [k, v] of Object.entries(decision.rewritten)) {
					(context.args as Record<string, unknown>)[k] = v;
				}
			}
			return undefined;
		};
		this.agent.afterToolCall = async (context) => {
			this.toolGuard?.afterToolCall?.(
				{ name: context.toolCall.name, arguments: (context.args ?? {}) as Record<string, unknown> },
				{ ok: !context.isError, durationMs: 0 },
			);
			return undefined;
		};
	}

	private skillStateDegraded = false;

	async process(input: AgentTurnInput): Promise<AgentTurnResult> {
		if (this.skillState !== null && !this.skillStateDegraded) {
			return this.processWithSkillState(input);
		}
		await this.agent.prompt(input.userText);
		return extractResult(this.agent.state.messages);
	}

	/**
	 * P3：(P, Σ, O) 上下文协议（06 §5/§6 严格性）。
	 * - 历史剥离：每步发给模型的只有 [system(P, 工具声明), user(Σ_t + O_t)]——
	 *   历史观察/动作/推理绝不进入 prompt（R_t 即弃，session 树留档由调用方负责）
	 * - rollback-retry：无效补丁（解析或整体校验失败）注入纠错消息重试，上限
	 *   3 次；仍失败 → 降级回退完整历史并通知（06 §7）
	 */
	private async processWithSkillState(input: AgentTurnInput): Promise<AgentTurnResult> {
		const binding = this.skillState;
		if (binding === null) throw new Error("skillState unexpectedly null");

		let promptText = `${binding.buildContext().userPrompt}\n\nLatest Observation:\n${input.userText}`;
		let result: AgentTurnResult | null = null;
		for (let attempt = 0; attempt <= MAX_PATCH_RETRIES; attempt++) {
			this.stripToProtocolOnly(binding.buildContext().systemPrompt);
			await this.agent.prompt(promptText);
			result = extractResult(this.agent.state.messages);
			if (result.assistantText.length === 0 && attempt === 0) {
				// 模型空回复（错误/中断）：交回调用方，不消耗重试额度
				return result;
			}
			const parsed = binding.parseStatePatch(result.assistantText);
			const errors = [...parsed.errors];
			if (errors.length === 0 && parsed.patch !== undefined && binding.applyPatch !== undefined) {
				const applied = binding.applyPatch(parsed.patch);
				if (!applied.ok) errors.push(...applied.errors);
			}
			if (errors.length === 0) {
				this.onStateEvent?.("state.patch", { ok: true, retryCount: attempt });
				return result;
			}
			this.onStateEvent?.("state.patch", { ok: false, retryCount: attempt + 1, errors: errors.slice(0, 3) });
			// rollback-retry：无效补丁不合并状态，错误注入下一条用户侧消息（06 §3）
			promptText =
				`你的 state_patch 无效：${errors.join("；")}。\n` +
				`当前状态为：\n\`\`\`json\n${JSON.stringify(binding.buildContext().userPrompt)}\n\`\`\`\n` +
				"请重新输出完整的 state_patch（单 key state_patch、点路径、null 删除）。";
		}
		// 重试超限 → 降级（06 §7）：回退完整历史模式，Σ 语义由调用方接管
		this.skillStateDegraded = true;
		this.onStateEvent?.("compaction", { strategy: "skill-state", degraded: true });
		binding.onDegraded?.(`state_patch 连续 ${MAX_PATCH_RETRIES} 次无效，已降级为完整历史模式`);
		return result as AgentTurnResult;
	}

	/** 历史剥离：transcript 重建为 [system(P + 工具声明)]，prompt() 再追加 user(Σ,O) */
	private stripToProtocolOnly(systemPrompt: string): void {
		const sys = this.agent.state.messages.find((m) => m.role === "system");
		const toolsAdded =
			sys !== undefined && "toolsAdded" in sys && Array.isArray((sys as { toolsAdded?: unknown }).toolsAdded)
				? (sys as { toolsAdded: unknown[] }).toolsAdded
				: undefined;
		const rebuilt = {
			role: "system",
			content: systemPrompt,
			...(toolsAdded !== undefined ? { toolsAdded } : {}),
			timestamp: 0,
		};
		this.agent.state.messages = [rebuilt as AgentMessage];
	}

	unregister(): void {
		this.faux?.unregister();
	}

	/** 测试辅助：暴露内部消息（仅调试/测试断言用） */
	debugMessages(): AgentMessage[] {
		return this.agent.state.messages.slice();
	}

	/** 04 §5.4 状态行数据：模型/思考强度/上下文窗口 */
	runtimeInfo(): { modelId: string; thinkingLevel: string; contextWindow: number } {
		const m = this.agent.state.model as { id?: string; contextWindow?: number };
		return {
			modelId: m.id ?? "unknown",
			thinkingLevel: this.agent.state.thinkingLevel,
			contextWindow: m.contextWindow ?? 0,
		};
	}

	setThinkingLevel(level: "off" | "low" | "medium" | "high"): void {
		this.agent.state.thinkingLevel = level;
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

export { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider };
export type { FauxProviderRegistration };
