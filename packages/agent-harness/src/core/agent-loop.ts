/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import type { Model, SimpleStreamOptions } from "@loopiq/ai";
import {
	type AssistantMessage,
	type Context,
	streamSimple,
	type ToolResultMessage,
} from "@loopiq/ai/compat";
import type { AgentEventSink, AgentHookEmitter } from "../base/events.ts";
import { type AgentMessage, convertToLlm } from "../base/messages.ts";
import type {
	AgentContext,
	AgentLoopTurnUpdate,
	PrepareNextTurnContext,
	ShouldStopAfterTurnContext,
	StreamFn,
} from "../base/options.ts";
import type { ToolExecutionMode } from "../base/resource.ts";
import { executeToolCalls } from "./tool-execution.ts";

/**
 * Direct parameters handed to the agent loop.
 *
 * Plain data (`model`, `reasoning`, `toolExecution`) is passed by value. The
 * remaining callbacks are still supplied by the harness for now; the loop no
 * longer exposes them as external "hooks".
 */
export interface AgentLoopParams {
	/** Model used for provider requests. */
	model: Model<any>;
	/** Reasoning/thinking level forwarded to the stream function. */
	reasoning?: SimpleStreamOptions["reasoning"];
	/** Tool execution mode. Default: "parallel". */
	toolExecution?: ToolExecutionMode;

	// TODO 以后修改：以下两个函数暂时作为钩子传入，未来应在 agent loop 内实现，
	// 或移除它们对 harness 运行时状态的耦合。
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	// TODO 以后修改：steering / follow-up 队列消息目前仍由 harness 提供。
	getSteeringMessages?: () => Promise<AgentMessage[]>;
	getFollowUpMessages?: () => Promise<AgentMessage[]>;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	params: AgentLoopParams,
	emit: AgentEventSink,
	emitHook: AgentHookEmitter,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, params, signal, emit, emitHook, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	params: AgentLoopParams,
	emit: AgentEventSink,
	emitHook: AgentHookEmitter,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, params, signal, emit, emitHook, streamFn);
	return newMessages;
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	params: AgentLoopParams,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	emitHook: AgentHookEmitter,
	streamFn?: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let model = params.model;
	let reasoning = params.reasoning;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await params.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(
				currentContext,
				model,
				reasoning,
				signal,
				emit,
				emitHook,
				streamFn,
			);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				const executedToolBatch = await executeToolCalls(
					currentContext,
					message,
					params.toolExecution,
					signal,
					emit,
					emitHook,
				);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await params.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				model = nextTurnSnapshot.model ?? model;
				reasoning =
					nextTurnSnapshot.thinkingLevel === undefined
						? reasoning
						: nextTurnSnapshot.thinkingLevel === "off"
							? undefined
							: nextTurnSnapshot.thinkingLevel;
			}

			if (
				await params.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await params.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await params.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	model: Model<any>,
	reasoning: SimpleStreamOptions["reasoning"],
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	emitHook: AgentHookEmitter,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply the `context` hook if any handler is registered (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	const contextResult = await emitHook({ type: "context", messages: [...messages] });
	if (contextResult?.messages) {
		messages = contextResult.messages;
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// TODO: to be check —— getApiKey 用于动态解析 API key（用于会过期的 token），
	// 目前留空返回 undefined，resolvedApiKey 的方案后续再定。
	const getApiKey = (_provider: string): Promise<string | undefined> | string | undefined => undefined;
	const resolvedApiKey = await getApiKey(model.provider);

	const response = await streamFunction(model, llmContext, {
		reasoning,
		apiKey: resolvedApiKey,
		signal,
	});

	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
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
					await emit({
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
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}
