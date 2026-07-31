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
import type { AgentMessage } from "../base/messages.ts";
import type { AgentContext } from "../base/options.ts";
import { AgentRuntimeError, toError } from "../base/types.ts";
import type { AgentRunControlView, InferenceInterruptReason } from "./agent-run-control.ts";
import type { AgentRunOutcome } from "./agent-run-outcome.ts";
import type { AgentRunPort } from "./agent-run-port.ts";
import { createFailureMessage, createUserMessage } from "./message-factory.ts";
import { executeToolCalls } from "./tool-execution.ts";
import { createAgentContext, type TurnState } from "./turn-state.ts";

export interface AgentUserInput {
	text: string;
	images?: ImageContent[];
}

export interface AgentRunInput extends AgentUserInput {
	sessionId: string;
	initialMessages: AgentMessage[];
	initialSnapshot: TurnState;
	control: AgentRunControlView;
}

export class AgentRun {
	private activeSnapshot: TurnState;
	private readonly models: Pick<Models, "streamSimple">;
	private readonly input: AgentRunInput;
	private readonly port: AgentRunPort;

	constructor(models: Pick<Models, "streamSimple">, input: AgentRunInput, port: AgentRunPort) {
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
					error: new AgentRuntimeError("invalid_state", "AgentRun completed without an assistant message"),
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
		const prompts: AgentMessage[] = [createUserMessage(this.input.text, this.input.images)];
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext = createAgentContext(this.activeSnapshot, [...this.input.initialMessages, ...prompts]);

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
				throw new AgentRuntimeError("unknown", cause.message, cause);
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
				currentContext = createAgentContext(this.activeSnapshot, currentContext.messages);
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
				const executed = await executeToolCalls(currentContext, message, this.input.control.runSignal, (event) =>
					this.handleAgentEvent(event),
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
			currentContext = createAgentContext(this.activeSnapshot, currentContext.messages);
			model = this.activeSnapshot.model;
			reasoning = this.reasoningForSnapshot();
			pendingMessages = await this.port.drainSteering();
		}

		await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
	}

	private reasoningForSnapshot(): SimpleStreamOptions["reasoning"] {
		return this.activeSnapshot.thinkingLevel === "off" ? undefined : this.activeSnapshot.thinkingLevel;
	}

	private async refreshSnapshot(): Promise<void> {
		await this.port.flushPendingSessionState();
		this.activeSnapshot = this.port.createTurnSnapshot();
	}

	private async streamAssistant(
		context: AgentContext,
		model: Model<any>,
		reasoning: SimpleStreamOptions["reasoning"],
	): Promise<{ message: AssistantMessage; interruptReason?: InferenceInterruptReason }> {
		const llmContext: Context = {
			systemPrompt: context.systemPrompt,
			messages: context.messages,
			tools: context.tools,
		};
		const requestOptions = this.activeSnapshot.providerRequestPolicy;
		const inference = this.input.control.openInferenceScope();

		try {
			const response = await this.models.streamSimple(model, llmContext, {
				cacheRetention: requestOptions.cacheRetention,
				maxRetries: requestOptions.maxRetries,
				maxRetryDelayMs: requestOptions.maxRetryDelayMs,
				onResponse: async (providerResponse) => {
					await this.port.emit({
						type: "after_provider_response",
						status: providerResponse.status,
						headers: { ...(providerResponse.headers as Record<string, string>) },
					});
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
					case "text_end":
					case "thinking_start":
					case "thinking_end":
					case "toolcall_start":
					case "toolcall_end":
						if (partialMessage) {
							partialMessage = event.partial;
							context.messages[context.messages.length - 1] = partialMessage;
							await this.handleAgentEvent({
								type: "message_update",
								update: { type: event.type, contentIndex: event.contentIndex },
							});
						}
						break;
					case "text_delta":
					case "thinking_delta":
					case "toolcall_delta":
						if (partialMessage) {
							partialMessage = event.partial;
							context.messages[context.messages.length - 1] = partialMessage;
							await this.handleAgentEvent({
								type: "message_update",
								update: { type: event.type, contentIndex: event.contentIndex, delta: event.delta },
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
		if (event.type === "message_end") {
			await this.port.commitMessage(event.message);
			await this.port.emit(event);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.port.emit(event);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = await this.port.flushPendingSessionState();
			if (eventError) throw eventError;
			await this.port.emit({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.port.flushPendingSessionState();
			await this.port.emit(event);
			return;
		}
		await this.port.emit(event);
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
