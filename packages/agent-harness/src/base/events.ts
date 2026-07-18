import type { AssistantMessageEvent, ImageContent, Model, TextContent, ToolResultMessage } from "@loopiq/ai";

import type { AgentMessage } from "./messages.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch, ThinkingLevel } from "./options.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./resource.ts";
import type { CompactionEntry, CompactionPreparation, SessionEntry } from "./session-types.ts";

export interface QueueUpdateEvent {
	type: "queue_update";
	steer: AgentMessage[];
	followUp: AgentMessage[];
	nextTurn: AgentMessage[];
}

export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

export interface AbortEvent {
	type: "abort";
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface SettledEvent {
	type: "settled";
	nextTurnCount: number;
}

export interface BeforeAgentStartEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "before_agent_start";
	prompt: string;
	images?: ImageContent[];
	systemPrompt: string;
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	model: Model<any>;
	sessionId: string;
	streamOptions: AgentHarnessStreamOptions;
}

export interface BeforeProviderPayloadEvent {
	type: "before_provider_payload";
	model: Model<any>;
	payload: unknown;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: Array<TextContent | ImageContent>;
	details: unknown;
	isError: boolean;
}

export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	entries: SessionEntry[];
	customInstructions?: string;
	signal: AbortSignal;
}

export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromHook: boolean;
}

export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}

export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface ToolsUpdateEvent {
	type: "tools_update";
	toolNames: string[];
	previousToolNames: string[];
	activeToolNames: string[];
	previousActiveToolNames: string[];
	source: "set" | "restore";
}

export interface ResourcesUpdateEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	type: "resources_update";
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	previousResources: AgentHarnessResources<TSkill, TPromptTemplate>;
}

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
	// Only emitted for assistant messages during streaming
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// Tool execution lifecycle
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };

/**
 * Read-only notification events: agent-run lifecycle plus harness state changes.
 *
 * These are broadcast to `subscribe()` listeners and carry no return-value
 * semantics. `agent_end` is the last event emitted for a run, but awaited
 * `subscribe()` listeners for that event are still part of run settlement; the
 * agent becomes idle only after those listeners finish.
 */
export type AgentNotificationEvent<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> =
	| AgentRunEvent
	// Harness state-change notifications
	| QueueUpdateEvent
	| SavePointEvent
	| AbortEvent
	| SettledEvent
	| AfterProviderResponseEvent
	| SessionCompactEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ResourcesUpdateEvent<TSkill, TPromptTemplate>
	| ToolsUpdateEvent;

/**
 * Hook events: intercepted via `on(type)` handlers whose return value is
 * consumed by the harness (see {@link AgentHookEventResultMap}). Unlike
 * {@link AgentNotificationEvent}s, these are NOT broadcast to `subscribe()`.
 */
export type AgentHookEvent<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate> =
	| BeforeAgentStartEvent<TSkill, TPromptTemplate>
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderPayloadEvent
	| ToolCallEvent
	| ToolResultEvent
	| SessionBeforeCompactEvent;

export interface BeforeAgentStartResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

export interface ContextResult {
	messages: AgentMessage[];
}

export interface BeforeProviderRequestResult {
	streamOptions?: AgentHarnessStreamOptionsPatch;
}

export interface BeforeProviderPayloadResult {
	payload: unknown;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: unknown;
	isError?: boolean;
	terminate?: boolean;
}

export interface CompactResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactResult;
}

/**
 * Maps each {@link AgentHookEvent} `type` to the result its `on(type)` handler
 * may return for the harness to consume. Only interceptable hook events appear
 * here; read-only {@link AgentNotificationEvent}s are observed via `subscribe()`.
 */
export type AgentHookEventResultMap = {
	before_agent_start: BeforeAgentStartResult | undefined;
	context: ContextResult | undefined;
	before_provider_request: BeforeProviderRequestResult | undefined;
	before_provider_payload: BeforeProviderPayloadResult | undefined;
	tool_call: ToolCallResult | undefined;
	tool_result: ToolResultPatch | undefined;
	session_before_compact: SessionBeforeCompactResult | undefined;
};

/**
 * Return-valued hook dispatch channel handed to the low-level agent loop.
 *
 * Unlike {@link AgentEventSink} (read-only notifications), this dispatches an
 * {@link AgentHookEvent} and yields the harness-consumed result for that hook
 * type. The harness supplies this so the loop can route interceptable hooks
 * (`context`, `tool_call`, `tool_result`) through the same `on(type)` handlers
 * as every other hook, instead of via bespoke config callbacks.
 */
export type AgentHookEmitter = <TType extends keyof AgentHookEventResultMap>(
	event: Extract<AgentHookEvent, { type: TType }>,
) => Promise<AgentHookEventResultMap[TType] | undefined>;

/**
 * The agent loop only ever emits {@link AgentRunEvent}s into the harness
 * (the harness-owned hook events are emitted separately).
 */
export type AgentEventSink = (event: AgentRunEvent) => Promise<void> | void;
