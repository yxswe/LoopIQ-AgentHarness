import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	Models,
	SimpleStreamOptions,
	ToolResultMessage,
} from "@loopiq/ai";
import type { AgentRunEvent } from "../base/events.ts";
import { type AgentMessage, convertToLlm } from "../base/messages.ts";
import type { AgentContext, AgentHarnessStreamOptions } from "../base/options.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import { AgentHarnessError, toError } from "../base/types.ts";
import { createFailureMessage, createUserMessage } from "../core/message-factory.ts";
import { cloneStreamOptions } from "../core/stream-options.ts";
import { executeToolCalls } from "../core/tool-execution.ts";
import { buildContext, type TurnState } from "../core/turn-state.ts";
import type { AgentRunControlView, InferenceInterruptReason } from "./agent-run-control.ts";
import type { AgentRunOutcome } from "./agent-run-outcome.ts";
import type { AgentRunPort } from "./agent-run-port.ts";

export interface AgentUserInput {
	text: string;
	images?: ImageContent[];
}

export interface AgentRunInput<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	sessionId: string;
	runId: string;
	input: AgentUserInput;
	initialSnapshot: TurnState<TSkill, TPromptTemplate, TTool>;
	control: AgentRunControlView;
}

export class AgentRun<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	private activeSnapshot: TurnState<TSkill, TPromptTemplate, TTool>;
	private readonly models: Pick<Models, "streamSimple">;
	private readonly input: AgentRunInput<TSkill, TPromptTemplate, TTool>;
	private readonly port: AgentRunPort<TSkill, TPromptTemplate, TTool>;

	constructor(
		models: Pick<Models, "streamSimple">,
		input: AgentRunInput<TSkill, TPromptTemplate, TTool>,
		port: AgentRunPort<TSkill, TPromptTemplate, TTool>,
	) {
		this.models = models;
		this.input = input;
		this.port = port;
		this.activeSnapshot = input.initialSnapshot;
	}

	async execute(): Promise<AgentRunOutcome> {
		try {
			const messages = await this.run();
			const finalMessage = [...messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			if (!finalMessage) {
				return {
					status: "failed",
					messages,
					error: new AgentHarnessError("invalid_state", "AgentRun completed without an assistant message"),
				};
			}
			if (finalMessage.stopReason === "aborted") return { status: "aborted", messages, finalMessage };
			if (finalMessage.stopReason === "error") {
				return {
					status: "failed",
					messages,
					finalMessage,
					error: new Error(finalMessage.errorMessage ?? "Provider request failed"),
				};
			}
			return { status: "completed", messages, finalMessage };
		} catch (error) {
			return { status: "failed", messages: [], error: toError(error) };
		}
	}

	private async run(): Promise<AgentMessage[]> {
		let prompts: AgentMessage[] = [createUserMessage(this.input.input.text, this.input.input.images)];
		const queued = await this.port.takeNextTurn();
		if (queued.length > 0) prompts = [...queued, prompts[0]!];

		const beforeResult = await this.port.emitHook(
			{
				type: "before_agent_start",
				prompt: this.input.input.text,
				images: this.input.input.images,
				systemPrompt: this.activeSnapshot.systemPrompt,
				resources: this.activeSnapshot.resources,
			},
			this.input.control.runSignal,
		);
		if (beforeResult?.messages) prompts = [...prompts, ...beforeResult.messages];

		const newMessages: AgentMessage[] = [...prompts];
		const initialContext = buildContext(this.activeSnapshot, beforeResult?.systemPrompt);
		const currentContext: AgentContext = {
			...initialContext,
			messages: [...initialContext.messages, ...prompts],
		};

		try {
			await this.handleAgentEvent({ type: "agent_start" });
			await this.handleAgentEvent({ type: "turn_start" });
			for (const prompt of prompts) {
				await this.handleAgentEvent({ type: "message_start", message: prompt });
				await this.handleAgentEvent({ type: "message_end", message: prompt });
			}
			await this.runLoop(currentContext, newMessages);
			return newMessages;
		} catch (error) {
			try {
				return await this.emitRunFailure(this.activeSnapshot.model, error, this.input.control.runSignal.aborted);
			} catch (failureError) {
				const cause = new AggregateError(
					[toError(error), toError(failureError)],
					"Agent run failed and failure reporting failed",
				);
				throw new AgentHarnessError("unknown", cause.message, cause);
			}
		}
	}

	private async runLoop(initialContext: AgentContext, newMessages: AgentMessage[]): Promise<void> {
		let currentContext = initialContext;
		let model: Model<any> = this.activeSnapshot.model;
		let reasoning: SimpleStreamOptions["reasoning"] =
			this.activeSnapshot.thinkingLevel === "off" ? undefined : this.activeSnapshot.thinkingLevel;
		let firstTurn = true;
		let pendingMessages = await this.port.drainSteering();

		while (true) {
			let hasMoreToolCalls = true;
			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (!firstTurn) await this.handleAgentEvent({ type: "turn_start" });
				else firstTurn = false;

				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						await this.handleAgentEvent({ type: "message_start", message });
						await this.handleAgentEvent({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				const streamed = await this.streamAssistant(currentContext, model, reasoning);
				const message = streamed.message;
				newMessages.push(message);
				if (streamed.interruptReason === "steer" && !this.input.control.runSignal.aborted) {
					await this.handleAgentEvent({ type: "turn_end", message, toolResults: [] });
					await this.refreshSnapshot();
					currentContext = buildContext(this.activeSnapshot);
					model = this.activeSnapshot.model;
					reasoning = this.reasoningForSnapshot();
					pendingMessages = await this.port.drainSteering();
					hasMoreToolCalls = false;
					continue;
				}

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					await this.handleAgentEvent({ type: "turn_end", message, toolResults: [] });
					await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter((content) => content.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				hasMoreToolCalls = false;
				if (toolCalls.length > 0) {
					const executed = await executeToolCalls(
						currentContext,
						message,
						undefined,
						this.input.control.runSignal,
						(event) => this.handleAgentEvent(event),
						(event) => this.port.emitHook(event, this.input.control.runSignal),
					);
					toolResults.push(...executed.messages);
					hasMoreToolCalls = !executed.terminate;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await this.handleAgentEvent({ type: "turn_end", message, toolResults });
				await this.refreshSnapshot();
				currentContext = buildContext(this.activeSnapshot);
				model = this.activeSnapshot.model;
				reasoning = this.reasoningForSnapshot();
				pendingMessages = await this.port.drainSteering();
			}

			const followUpMessages = await this.port.drainFollowUp();
			if (followUpMessages.length > 0) {
				pendingMessages = followUpMessages;
				continue;
			}
			break;
		}

		await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
	}

	private reasoningForSnapshot(): SimpleStreamOptions["reasoning"] {
		return this.activeSnapshot.thinkingLevel === "off" ? undefined : this.activeSnapshot.thinkingLevel;
	}

	private async refreshSnapshot(): Promise<void> {
		await this.port.flushPendingWrites();
		this.activeSnapshot = await this.port.createTurnSnapshot(this.input.control.runSignal);
	}

	private async streamAssistant(
		context: AgentContext,
		model: Model<any>,
		reasoning: SimpleStreamOptions["reasoning"],
	): Promise<{ message: AssistantMessage; interruptReason?: InferenceInterruptReason }> {
		let messages = context.messages;
		const contextResult = await this.port.emitHook(
			{ type: "context", messages: [...messages] },
			this.input.control.runSignal,
		);
		if (contextResult?.messages) messages = contextResult.messages;

		const llmContext: Context = {
			systemPrompt: context.systemPrompt,
			messages: convertToLlm(messages),
			tools: context.tools,
		};
		const snapshotOptions = cloneStreamOptions(this.activeSnapshot.streamOptions);
		const requestPatch = await this.port.emitHook(
			{
				type: "before_provider_request",
				model,
				sessionId: this.input.sessionId,
				streamOptions: cloneStreamOptions(snapshotOptions),
			},
			this.input.control.runSignal,
		);
		const requestOptions = requestPatch?.streamOptions
			? cloneStreamOptions(requestPatch.streamOptions as AgentHarnessStreamOptions)
			: snapshotOptions;
		const inference = this.input.control.openInferenceScope();

		try {
			const response = await this.models.streamSimple(model, llmContext, {
				cacheRetention: requestOptions.cacheRetention,
				headers: requestOptions.headers,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				metadata: requestOptions.metadata,
				onPayload: async (payload) => {
					const result = await this.port.emitHook(
						{ type: "before_provider_payload", model, payload },
						inference.signal,
					);
					return result?.payload ?? payload;
				},
				onResponse: async (providerResponse) => {
					await this.port.emit(
						{
							type: "after_provider_response",
							status: providerResponse.status,
							headers: { ...(providerResponse.headers as Record<string, string>) },
						},
						inference.signal,
					);
				},
				reasoning,
				signal: inference.signal,
				sessionId: this.input.sessionId,
				timeoutMs: requestOptions.timeoutMs,
				transport: requestOptions.transport,
			});

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;
			for await (const event of response) {
				switch (event.type) {
					case "start":
						partialMessage = event.partial;
						context.messages.push(partialMessage);
						addedPartial = true;
						await this.handleAgentEvent({ type: "message_start", message: { ...partialMessage } });
						break;
					case "text_start":
					case "text_delta":
					case "text_end":
					case "thinking_start":
					case "thinking_delta":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_delta":
					case "toolcall_end":
						if (partialMessage) {
							partialMessage = event.partial;
							context.messages[context.messages.length - 1] = partialMessage;
							await this.handleAgentEvent({
								type: "message_update",
								assistantMessageEvent: event,
								message: { ...partialMessage },
							});
						}
						break;
					case "done":
					case "error": {
						const finalMessage = await response.result();
						if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
						else context.messages.push(finalMessage);
						if (!addedPartial) {
							await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
						}
						await this.handleAgentEvent({ type: "message_end", message: finalMessage });
						return { message: finalMessage, interruptReason: inference.getInterruptReason() };
					}
				}
			}

			const finalMessage = await response.result();
			if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
			else {
				context.messages.push(finalMessage);
				await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
			}
			await this.handleAgentEvent({ type: "message_end", message: finalMessage });
			return { message: finalMessage, interruptReason: inference.getInterruptReason() };
		} finally {
			inference.close();
		}
	}

	private async handleAgentEvent(event: AgentRunEvent): Promise<void> {
		const signal = this.input.control.runSignal;
		if (event.type === "message_end") {
			await this.port.commitMessage(event.message);
			await this.port.emit(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.port.emit(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.port.hasPendingWrites();
			await this.port.flushPendingWrites();
			if (eventError) throw eventError;
			await this.port.emit({ type: "save_point", hadPendingMutations }, signal);
			return;
		}
		if (event.type === "agent_end") {
			await this.port.flushPendingWrites();
			await this.port.emit(event, signal);
			return;
		}
		await this.port.emit(event, signal);
	}

	private async emitRunFailure(model: Model<any>, error: unknown, aborted: boolean): Promise<AgentMessage[]> {
		const failureMessage = createFailureMessage(model, error, aborted);
		await this.handleAgentEvent({ type: "message_start", message: failureMessage });
		await this.handleAgentEvent({ type: "message_end", message: failureMessage });
		await this.handleAgentEvent({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] });
		return [failureMessage];
	}
}
