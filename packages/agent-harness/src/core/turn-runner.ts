import type { Model, Models, SimpleStreamOptions } from "@loopiq/ai";
import type { AssistantMessage, Context, ToolResultMessage } from "@loopiq/ai/compat";

import type { AgentRunEvent } from "../base/events.ts";
import { type AgentMessage, convertToLlm } from "../base/messages.ts";
import type { AgentContext, AgentHarnessStreamOptions, QueueMode } from "../base/options.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import { AgentHarnessError, normalizeHookError, toError } from "../base/types.ts";
import type { MessageQueues } from "../queue/message-queues.ts";
import type { Session } from "../session/session.ts";
import type { SessionWriter } from "../session/session-writer.ts";
import type { AgentEventBus } from "./event-bus.ts";
import { createFailureMessage } from "./message-factory.ts";
import { applyStreamOptionsPatch, cloneStreamOptions } from "./stream-options.ts";
import { executeToolCalls } from "./tool-execution.ts";
import { buildContext, type TurnState } from "./turn-state.ts";

export interface TurnRunnerDeps<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	session: Session;
	models: Models;
	events: AgentEventBus<TSkill, TPromptTemplate>;
	queues: MessageQueues;
	sessionWriter: SessionWriter;
	signal: AbortSignal;
	steeringMode: QueueMode;
	followUpMode: QueueMode;
	turnState: TurnState<TSkill, TPromptTemplate, TTool>;
	refreshTurnState: () => Promise<TurnState<TSkill, TPromptTemplate, TTool>>;
	emitQueueUpdate: () => Promise<void>;
	markIdle: () => void;
}

/**
 * Short-lived run driver for a single agent run. Absorbs the former agent loop
 * plus the harness executeTurn/handleAgentEvent/emitRunFailure logic, without
 * the AgentLoopParams callback layer.
 */
export class TurnRunner<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	private readonly deps: TurnRunnerDeps<TSkill, TPromptTemplate, TTool>;
	private activeTurnState: TurnState<TSkill, TPromptTemplate, TTool>;

	constructor(deps: TurnRunnerDeps<TSkill, TPromptTemplate, TTool>) {
		this.deps = deps;
		this.activeTurnState = deps.turnState;
	}

	async run(prompts: AgentMessage[], context: AgentContext): Promise<AgentMessage[]> {
		const newMessages: AgentMessage[] = [...prompts];
		const currentContext: AgentContext = {
			...context,
			messages: [...context.messages, ...prompts],
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
				return await this.emitRunFailure(this.activeTurnState.model, error, this.deps.signal.aborted);
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
		let model: Model<any> = this.activeTurnState.model;
		let reasoning: SimpleStreamOptions["reasoning"] =
			this.activeTurnState.thinkingLevel === "off" ? undefined : this.activeTurnState.thinkingLevel;
		let firstTurn = true;
		let pendingMessages: AgentMessage[] = await this.deps.queues.drainSteer(
			this.deps.steeringMode,
			this.deps.emitQueueUpdate,
		);

		while (true) {
			let hasMoreToolCalls = true;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (!firstTurn) {
					await this.handleAgentEvent({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						await this.handleAgentEvent({ type: "message_start", message });
						await this.handleAgentEvent({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				const message = await this.streamAssistant(currentContext, model, reasoning);
				newMessages.push(message);

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					await this.handleAgentEvent({ type: "turn_end", message, toolResults: [] });
					await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
					return;
				}

				const toolCalls = message.content.filter((c) => c.type === "toolCall");
				const toolResults: ToolResultMessage[] = [];
				hasMoreToolCalls = false;
				if (toolCalls.length > 0) {
					const executedToolBatch = await executeToolCalls(
						currentContext,
						message,
						undefined,
						this.deps.signal,
						(event) => this.handleAgentEvent(event),
						this.deps.events.emitHook.bind(this.deps.events),
					);
					toolResults.push(...executedToolBatch.messages);
					hasMoreToolCalls = !executedToolBatch.terminate;
					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				}

				await this.handleAgentEvent({ type: "turn_end", message, toolResults });

				// prepareNextTurn inlined: flush writes enqueued during save_point
				// subscribers, then refresh the snapshot for the next request.
				await this.deps.sessionWriter.flush();
				this.activeTurnState = await this.deps.refreshTurnState();
				currentContext = buildContext(this.activeTurnState);
				model = this.activeTurnState.model;
				reasoning = this.activeTurnState.thinkingLevel === "off" ? undefined : this.activeTurnState.thinkingLevel;

				pendingMessages = await this.deps.queues.drainSteer(this.deps.steeringMode, this.deps.emitQueueUpdate);
			}

			const followUpMessages = await this.deps.queues.drainFollowUp(
				this.deps.followUpMode,
				this.deps.emitQueueUpdate,
			);
			if (followUpMessages.length > 0) {
				pendingMessages = followUpMessages;
				continue;
			}
			break;
		}

		await this.handleAgentEvent({ type: "agent_end", messages: newMessages });
	}

	private async streamAssistant(
		context: AgentContext,
		model: Model<any>,
		reasoning: SimpleStreamOptions["reasoning"],
	): Promise<AssistantMessage> {
		let messages = context.messages;
		const contextResult = await this.deps.events.emitHook({ type: "context", messages: [...messages] });
		if (contextResult?.messages) {
			messages = contextResult.messages;
		}

		const llmMessages = convertToLlm(messages);
		const llmContext: Context = {
			systemPrompt: context.systemPrompt,
			messages: llmMessages,
			tools: context.tools,
		};

		const turnState = this.activeTurnState;
		const snapshotOptions: AgentHarnessStreamOptions = { ...turnState.streamOptions };
		const requestOptions = await this.emitBeforeProviderRequest(model, turnState.sessionId, snapshotOptions);

		const response = await this.deps.models.streamSimple(model, llmContext, {
			cacheRetention: requestOptions.cacheRetention,
			headers: requestOptions.headers,
			maxRetries: requestOptions.maxRetries,
			maxRetryDelayMs: requestOptions.maxRetryDelayMs,
			metadata: requestOptions.metadata,
			onPayload: async (payload) => await this.deps.events.emitBeforeProviderPayload(model, payload),
			onResponse: async (providerResponse) => {
				const headers = { ...(providerResponse.headers as Record<string, string>) };
				await this.deps.events.emit(
					{ type: "after_provider_response", status: providerResponse.status, headers },
					this.deps.signal,
				);
			},
			reasoning,
			signal: this.deps.signal,
			sessionId: turnState.sessionId,
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
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
					}
					await this.handleAgentEvent({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
		}

		const finalMessage = await response.result();
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await this.handleAgentEvent({ type: "message_start", message: { ...finalMessage } });
		}
		await this.handleAgentEvent({ type: "message_end", message: finalMessage });
		return finalMessage;
	}

	private async emitBeforeProviderRequest(
		model: Model<any>,
		sessionId: string,
		streamOptions: AgentHarnessStreamOptions,
	): Promise<AgentHarnessStreamOptions> {
		const handlers = this.deps.events.getHandlers("before_provider_request");
		let current = cloneStreamOptions(streamOptions);
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({
					type: "before_provider_request",
					model,
					sessionId,
					streamOptions: cloneStreamOptions(current),
				});
				if (result?.streamOptions) {
					current = applyStreamOptionsPatch(current, result.streamOptions);
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}

	private async handleAgentEvent(event: AgentRunEvent): Promise<void> {
		const signal = this.deps.signal;
		if (event.type === "message_end") {
			await this.deps.session.appendMessage(event.message);
			await this.deps.events.emit(event, signal);
			return;
		}
		if (event.type === "turn_end") {
			let eventError: unknown;
			try {
				await this.deps.events.emit(event, signal);
			} catch (error) {
				eventError = error;
			}
			const hadPendingMutations = this.deps.sessionWriter.hasPending();
			await this.deps.sessionWriter.flush();
			if (eventError) throw eventError;
			await this.deps.events.emit({ type: "save_point", hadPendingMutations });
			return;
		}
		if (event.type === "agent_end") {
			await this.deps.sessionWriter.flush();
			this.deps.markIdle();
			await this.deps.events.emit(event, signal);
			await this.deps.events.emit(
				{ type: "settled", nextTurnCount: this.deps.queues.snapshot().nextTurn.length },
				signal,
			);
			return;
		}
		await this.deps.events.emit(event, signal);
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
