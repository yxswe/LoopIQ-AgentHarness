import type {
	AssistantMessage,
	ImageContent,
	Model,
	Models,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentContext, ProviderRequestPolicy } from "../base/options.ts";
import type { AgentTool } from "../base/resource.ts";
import {
	buildCompactionPrompt,
	COMPACTION_SYSTEM_PROMPT,
	CONTEXT_SUMMARY_PREFIX,
	CONTEXT_SUMMARY_SUFFIX,
} from "./compaction-prompt.ts";

const TRIGGER_RATIO = 0.9;
const TARGET_RATIO = 0.5;
const SUMMARY_MAX_TOKENS = 4096;
const ESTIMATED_IMAGE_TOKENS = 1200;
const TOOL_RESULT_SUMMARY_MAX_CHARS = 2000;

export type ContextCompactionErrorCode = "uncompactable" | "summarization_failed" | "invalid_summary" | "aborted";

export type ContextBudget = {
	contextWindow: number;
	beforeTokens: number;
	triggerTokens: number;
	targetTokens: number;
};

export class ContextCompactionError extends Error {
	readonly code: ContextCompactionErrorCode;
	readonly budget: ContextBudget;

	constructor(code: ContextCompactionErrorCode, message: string, budget: ContextBudget) {
		super(message);
		this.name = "ContextCompactionError";
		this.code = code;
		this.budget = budget;
	}
}

export type ContextCompactionPreparation = ContextBudget & {
	sourceMessageCount: number;
	compactedMessageCount: number;
	retainedMessages: AgentMessage[];
	messagesToSummarize: AgentMessage[];
	instructionPrefixMessages: AgentMessage[];
	previousSummary?: string;
	splitInstructionSpan: boolean;
	summaryMaxTokens: number;
};

export type ContextCompactionResult = ContextCompactionPreparation & {
	summary: UserMessage;
	messages: AgentMessage[];
	afterTokens: number;
	summaryTokens: number;
};

export type ContextCompactionExecution = {
	sessionId: string;
	model: Model<any>;
	providerRequestPolicy: ProviderRequestPolicy;
	systemPrompt: string;
	tools: AgentTool[];
	signal: AbortSignal;
};

/** Session-stateless context budgeting, cut-point planning, and summary generation. */
export class ContextManager {
	private readonly models: Pick<Models, "streamSimple">;

	constructor(models: Pick<Models, "streamSimple">) {
		this.models = models;
	}

	prepare(context: AgentContext, model: Model<any>): ContextCompactionPreparation | undefined {
		const budget = this.getBudget(context, model);
		if (budget.contextWindow <= 0 || budget.beforeTokens < budget.triggerTokens) return undefined;

		const messages = context.messages;
		this.validateToolHistory(messages, budget);
		const summaryMaxTokens = Math.min(SUMMARY_MAX_TOKENS, model.maxTokens > 0 ? model.maxTokens : SUMMARY_MAX_TOKENS);
		const previousSummary = this.extractPreviousSummary(messages[0]);
		const rawStart = previousSummary === undefined ? 0 : 1;
		const protectedStart = this.findProtectedStart(messages, budget);
		const prefixTokens = this.estimatePrefixTokens(context);
		let cutIndex: number | undefined;
		let newestLegalCut: number | undefined;
		let retainedTokens = 0;
		for (let index = messages.length - 1; index > rawStart; index--) {
			retainedTokens += this.estimateMessageTokens(messages[index]!);
			if (index > protectedStart || !this.isLegalCut(messages[index])) continue;
			newestLegalCut ??= index;
			if (prefixTokens + summaryMaxTokens + retainedTokens <= budget.targetTokens) cutIndex = index;
			else break;
		}
		cutIndex ??= newestLegalCut;
		if (cutIndex === undefined || cutIndex <= rawStart) {
			throw new ContextCompactionError("uncompactable", "Context has no safe non-empty prefix to compact", budget);
		}

		const cutMessage = messages[cutIndex];
		let instructionStart = -1;
		if (cutMessage?.role === "assistant") {
			for (let index = cutIndex - 1; index >= rawStart; index--) {
				if (messages[index]?.role === "user") {
					instructionStart = index;
					break;
				}
			}
		}
		const splitInstructionSpan = instructionStart >= rawStart;
		const historyEnd = splitInstructionSpan ? instructionStart : cutIndex;
		const messagesToSummarize = messages.slice(rawStart, historyEnd);
		const instructionPrefixMessages = splitInstructionSpan ? messages.slice(instructionStart, cutIndex) : [];
		if (messagesToSummarize.length === 0 && instructionPrefixMessages.length === 0) {
			throw new ContextCompactionError(
				"uncompactable",
				"Context has no new messages to incorporate into a summary",
				budget,
			);
		}

		return {
			...budget,
			sourceMessageCount: messages.length,
			compactedMessageCount: cutIndex,
			retainedMessages: messages.slice(cutIndex),
			messagesToSummarize,
			instructionPrefixMessages,
			previousSummary,
			splitInstructionSpan,
			summaryMaxTokens,
		};
	}

	async compact(
		preparation: ContextCompactionPreparation,
		execution: ContextCompactionExecution,
	): Promise<ContextCompactionResult> {
		if (execution.signal.aborted) {
			throw new ContextCompactionError("aborted", "Context compaction was aborted", preparation);
		}
		const conversation = this.serializeMessages(preparation.messagesToSummarize);
		const instructionPrefix = this.serializeMessages(preparation.instructionPrefixMessages);
		const prompt = buildCompactionPrompt({
			conversation: conversation || "No additional complete history.",
			previousSummary: preparation.previousSummary,
			instructionPrefix: instructionPrefix || undefined,
		});
		const requestOptions: SimpleStreamOptions = {
			cacheRetention: execution.providerRequestPolicy.cacheRetention,
			maxRetries: execution.providerRequestPolicy.maxRetries,
			maxRetryDelayMs: execution.providerRequestPolicy.maxRetryDelayMs,
			maxTokens: preparation.summaryMaxTokens,
			signal: execution.signal,
			sessionId: execution.sessionId,
			timeoutMs: execution.providerRequestPolicy.timeoutMs,
			transport: execution.providerRequestPolicy.transport,
		};
		let response: AssistantMessage;
		try {
			const stream = this.models.streamSimple(
				execution.model,
				{
					systemPrompt: COMPACTION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				requestOptions,
			);
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}
			response = await stream.result();
		} catch (error) {
			const aborted = execution.signal.aborted;
			throw new ContextCompactionError(
				aborted ? "aborted" : "summarization_failed",
				error instanceof Error ? error.message : aborted ? "Context compaction was aborted" : String(error),
				preparation,
			);
		}
		if (response.stopReason === "aborted" || execution.signal.aborted) {
			throw new ContextCompactionError(
				"aborted",
				response.errorMessage ?? "Context compaction was aborted",
				preparation,
			);
		}
		if (response.stopReason !== "stop") {
			throw new ContextCompactionError(
				"summarization_failed",
				response.errorMessage ?? `Context summarization stopped with ${response.stopReason}`,
				preparation,
			);
		}
		const summaryText = response.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (!summaryText) {
			throw new ContextCompactionError("invalid_summary", "Context summarization returned no text", preparation);
		}

		const latestTimestamp = preparation.retainedMessages.reduce(
			(latest, message) => Math.max(latest, message.timestamp),
			Date.now(),
		);
		const summary: UserMessage = {
			role: "user",
			content: [{ type: "text", text: CONTEXT_SUMMARY_PREFIX + summaryText + CONTEXT_SUMMARY_SUFFIX }],
			timestamp: latestTimestamp + 1,
		};
		const messages: AgentMessage[] = [summary, ...preparation.retainedMessages];
		const afterTokens =
			this.estimatePrefixTokens({
				systemPrompt: execution.systemPrompt,
				tools: execution.tools,
			}) + this.estimateMessages(messages);
		if (afterTokens >= preparation.beforeTokens || afterTokens >= preparation.triggerTokens) {
			throw new ContextCompactionError(
				"uncompactable",
				`Compacted context would still use ${afterTokens} tokens`,
				preparation,
			);
		}
		return {
			...preparation,
			summary,
			messages,
			afterTokens,
			summaryTokens: this.estimateMessageTokens(summary),
		};
	}

	private getBudget(context: AgentContext, model: Model<any>): ContextBudget {
		const contextWindow = model.contextWindow;
		return {
			contextWindow,
			beforeTokens: this.estimateCurrentTokens(context, model),
			triggerTokens: Math.floor(contextWindow * TRIGGER_RATIO),
			targetTokens: Math.floor(contextWindow * TARGET_RATIO),
		};
	}

	private estimateCurrentTokens(context: AgentContext, model: Model<any>): number {
		const summaryTimestamp = this.contextSummaryTimestamp(context.messages[0]);
		for (let index = context.messages.length - 1; index >= 0; index--) {
			const message = context.messages[index];
			if (message.role !== "assistant") continue;
			if (message.provider !== model.provider || message.model !== model.id) continue;
			if (message.stopReason === "aborted" || message.stopReason === "error") continue;
			if (summaryTimestamp !== undefined && message.timestamp <= summaryTimestamp) continue;
			const usageTokens = this.usageTokens(message);
			if (usageTokens <= 0) continue;
			return usageTokens + this.estimateMessages(context.messages.slice(index + 1));
		}
		return this.estimatePrefixTokens(context) + this.estimateMessages(context.messages);
	}

	private usageTokens(message: AssistantMessage): number {
		return (
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
		);
	}

	private estimatePrefixTokens(context: Pick<AgentContext, "systemPrompt" | "tools">): number {
		return (
			this.estimateTextTokens(context.systemPrompt) +
			(context.tools?.length ? this.estimateTextTokens(this.safeJsonStringify(context.tools)) : 0)
		);
	}

	private estimateMessages(messages: readonly AgentMessage[]): number {
		return messages.reduce((total, message) => total + this.estimateMessageTokens(message), 0);
	}

	private estimateMessageTokens(message: AgentMessage): number {
		if (message.role === "user") return this.estimateContentTokens(message.content);
		if (message.role === "toolResult") return this.estimateContentTokens(message.content);
		let tokens = 0;
		for (const content of message.content) {
			if (content.type === "text") tokens += this.estimateTextTokens(content.text);
			else if (content.type === "thinking") tokens += this.estimateTextTokens(content.thinking);
			else tokens += this.estimateTextTokens(content.name + this.safeJsonStringify(content.arguments));
		}
		return tokens;
	}

	private estimateContentTokens(content: string | (TextContent | ImageContent)[]): number {
		if (typeof content === "string") return this.estimateTextTokens(content);
		return content.reduce(
			(total, item) => total + (item.type === "text" ? this.estimateTextTokens(item.text) : ESTIMATED_IMAGE_TOKENS),
			0,
		);
	}

	private estimateTextTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	private findProtectedStart(messages: AgentMessage[], budget: ContextBudget): number {
		if (messages.length === 0) {
			throw new ContextCompactionError("uncompactable", "Context has no messages to compact", budget);
		}
		let index = messages.length - 1;
		if (messages[index]?.role === "user") {
			while (index > 0 && messages[index - 1]?.role === "user") index--;
			return index;
		}
		if (messages[index]?.role === "assistant") return index;

		const trailingResults: ToolResultMessage[] = [];
		while (index >= 0 && messages[index]?.role === "toolResult") {
			trailingResults.unshift(messages[index] as ToolResultMessage);
			index--;
		}
		const assistant = messages[index];
		if (assistant?.role !== "assistant") {
			throw new ContextCompactionError(
				"uncompactable",
				"Trailing tool results have no adjacent assistant tool call",
				budget,
			);
		}
		const callIds = new Set(
			assistant.content.filter((content) => content.type === "toolCall").map((content) => content.id),
		);
		if (trailingResults.some((result) => !callIds.has(result.toolCallId))) {
			throw new ContextCompactionError(
				"uncompactable",
				"Trailing tool results do not match their assistant tool calls",
				budget,
			);
		}
		return index;
	}

	private validateToolHistory(messages: readonly AgentMessage[], budget: ContextBudget): void {
		let pendingCallIds = new Set<string>();
		for (const message of messages) {
			if (message.role === "toolResult") {
				if (!pendingCallIds.delete(message.toolCallId)) {
					throw new ContextCompactionError(
						"uncompactable",
						`Tool result ${message.toolCallId} has no matching pending tool call`,
						budget,
					);
				}
				continue;
			}
			if (pendingCallIds.size > 0) {
				throw new ContextCompactionError("uncompactable", "Assistant tool calls are missing results", budget);
			}
			if (message.role !== "assistant") continue;
			pendingCallIds = new Set(
				message.content.filter((content) => content.type === "toolCall").map((content) => content.id),
			);
		}
		if (pendingCallIds.size > 0) {
			throw new ContextCompactionError("uncompactable", "Assistant tool calls are missing results", budget);
		}
	}

	private isLegalCut(message: AgentMessage): boolean {
		return message.role === "user" || message.role === "assistant";
	}

	private serializeMessages(messages: readonly AgentMessage[]): string {
		return messages
			.map((message) => {
				if (message.role === "user") return `[User]: ${this.serializeContent(message.content)}`;
				if (message.role === "toolResult") {
					const result = this.serializeContent(message.content);
					const truncated =
						result.length <= TOOL_RESULT_SUMMARY_MAX_CHARS
							? result
							: `${result.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS)}\n[... ${result.length - TOOL_RESULT_SUMMARY_MAX_CHARS} characters truncated]`;
					return `[Tool result ${message.toolName} (${message.toolCallId})]: ${truncated}`;
				}
				const parts: string[] = [];
				for (const content of message.content) {
					if (content.type === "text") parts.push(`[Assistant]: ${content.text}`);
					else if (content.type === "thinking") parts.push(`[Assistant thinking]: ${content.thinking}`);
					else {
						parts.push(
							`[Assistant tool call ${content.id}]: ${content.name}(${this.safeJsonStringify(content.arguments)})`,
						);
					}
				}
				return parts.join("\n");
			})
			.filter(Boolean)
			.join("\n\n");
	}

	private serializeContent(content: string | (TextContent | ImageContent)[]): string {
		if (typeof content === "string") return content;
		return content
			.map((item) =>
				item.type === "text" ? item.text : `[Image: ${item.mimeType}, ${item.data.length} encoded bytes]`,
			)
			.join("\n");
	}

	private extractPreviousSummary(message: AgentMessage | undefined): string | undefined {
		if (message?.role !== "user") return undefined;
		const text = this.userMessageText(message);
		if (!text.startsWith(CONTEXT_SUMMARY_PREFIX) || !text.endsWith(CONTEXT_SUMMARY_SUFFIX)) return undefined;
		return text.slice(CONTEXT_SUMMARY_PREFIX.length, -CONTEXT_SUMMARY_SUFFIX.length).trim();
	}

	private contextSummaryTimestamp(message: AgentMessage | undefined): number | undefined {
		return this.extractPreviousSummary(message) === undefined ? undefined : message!.timestamp;
	}

	private userMessageText(message: UserMessage): string {
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n");
	}

	private safeJsonStringify(value: unknown): string {
		try {
			return JSON.stringify(value) ?? "undefined";
		} catch {
			return "[unserializable]";
		}
	}
}
