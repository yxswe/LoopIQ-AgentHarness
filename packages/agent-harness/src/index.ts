// Platform-agnostic public barrel for @loopiq/agent-core.
//
// Exports the AgentHarness class plus its outward-facing interfaces and types.
// Internal implementation details (TurnRunner, SessionWriter, MessageQueues,
// concrete storage/env classes) are intentionally NOT exported here; node-only
// initialization lives in "./node.ts".

// Events (notification + hook)
export type {
	AgentHookEvent,
	AgentHookEventResultMap,
	AgentNotificationEvent,
	AgentRunEvent,
} from "./base/events.ts";
// Messages
export type {
	AgentMessage,
	BashExecutionMessage,
	CompactionSummaryMessage,
	CustomAgentMessages,
	CustomMessage,
} from "./base/messages.ts";
// Configuration & runtime options
export type {
	AgentHarnessOptions,
	AgentHarnessStreamOptions,
	AgentHarnessStreamOptionsPatch,
	QueueMode,
	ThinkingLevel,
} from "./base/options.ts";
// Resources (tools, skills, prompt templates)
export type {
	AgentHarnessResources,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
	PromptTemplate,
	Skill,
	ToolExecutionMode,
} from "./base/resource.ts";
// Session (public types only)
export type {
	AbortResult,
	AgentHarnessPromptOptions,
	Session,
	SessionMetadata,
	SessionTreeEntry,
} from "./base/session-types.ts";
export type { Result } from "./base/types.ts";

// Error classes (exported as values for `instanceof` checks) and Result type
export { AgentHarnessError, CompactionError, SessionError } from "./base/types.ts";
export { AgentHarness } from "./core/agent-harness.ts";
