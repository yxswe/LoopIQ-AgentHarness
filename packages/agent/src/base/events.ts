import type { Model, ToolResultMessage } from "@loopiq/ai";

import type { AgentMessage } from "./messages.ts";
import type { ModelReference, ThinkingLevel } from "./options.ts";

export interface ContextCompactionEventBase {
	model: ModelReference;
	contextWindow: number;
	triggerTokens: number;
	targetTokens: number;
	beforeTokens: number;
	sourceMessageCount: number;
}

export interface ContextCompactionStartedEvent extends ContextCompactionEventBase {
	type: "context_compaction_started";
}

export interface ContextCompactionCompletedEvent extends ContextCompactionEventBase {
	type: "context_compaction_completed";
	afterTokens: number;
	compactedMessageCount: number;
	retainedMessageCount: number;
	summaryTokens: number;
}

export interface ContextCompactionFailedEvent extends ContextCompactionEventBase {
	type: "context_compaction_failed";
	error: { code: string; message: string };
}

export interface SteeringQueueUpdateEvent {
	type: "steering_queue_update";
	messages: AgentMessage[];
}

export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	previousModel: Model<any>;
}

export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

/** Bounded assistant progress emitted without the Provider's growing partial message. */
export type AssistantMessageUpdate =
	| {
			type: "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" | "toolcall_end";
			contentIndex: number;
	  }
	| {
			type: "text_delta" | "thinking_delta" | "toolcall_delta";
			contentIndex: number;
			delta: string;
	  };

/**
 * Pure agent-run lifecycle events emitted by the agent loop (no generics, no
 * return-value semantics). This is the subset that flows through
 * {@link AgentEventSink}; it is also part of {@link AgentNotificationEvent}.
 */
export type AgentRunEvent =
	// Agent lifecycle
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// Turn lifecycle - a turn is one assistant response + any tool calls/results
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// Message lifecycle - emitted for user, assistant, and toolResult messages
	| { type: "message_start"; message: AgentMessage }
	// Only emitted for assistant messages during streaming; full content arrives at message_end
	| { type: "message_update"; update: AssistantMessageUpdate }
	| { type: "message_end"; message: AgentMessage }
	// Context maintenance lifecycle
	| ContextCompactionStartedEvent
	| ContextCompactionCompletedEvent
	| ContextCompactionFailedEvent
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

/**
 * Read-only notification events: agent-run lifecycle plus Session state changes.
 *
 * These are broadcast to `subscribe()` listeners and carry no return-value
 * semantics. `agent_end` is the final engine-loop event; Session settlement
 * notifications follow it. Awaited listeners remain part of settlement, and
 * the Session becomes idle only after terminal listeners finish.
 */
export type AgentNotificationEvent =
	| AgentRunEvent
	// Session state-change notifications
	| SteeringQueueUpdateEvent
	| SavePointEvent
	| AfterProviderResponseEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent;

/**
 * The agent loop only ever emits {@link AgentRunEvent}s into the Session
 * runtime (Session-owned hook events are emitted separately).
 */
export type AgentEventSink = (event: AgentRunEvent) => Promise<void> | void;
