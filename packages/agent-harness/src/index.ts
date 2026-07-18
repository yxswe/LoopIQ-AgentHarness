// Platform-agnostic public barrel for @loopiq/agent-core.
//
// Exports the AgentHarness class plus its outward-facing interfaces and types,
// the NodeExecutionEnv backend, and the built-in tool factories. Internal
// implementation details (TurnRunner, SessionWriter, MessageQueues, concrete
// storage classes) are intentionally NOT exported here.

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
// Session (public types only). The Session/Storage/tree structs are internal
// implementation details and are intentionally not re-exported; callers only
// touch sessions through the node factory (see "./node.ts").
export type { AbortResult } from "./base/session-types.ts";
export type { Result } from "./base/types.ts";

// Error classes (exported as values for `instanceof` checks) and Result type
export { AgentHarnessError, CompactionError, SessionError } from "./base/types.ts";
export { AgentHarness } from "./core/agent-harness.ts";
// Node execution environment (concrete backend used to build tools).
export { NodeExecutionEnv } from "./env/nodejs.ts";
// Built-in tools and the default tool-set factory.
export {
	type BashToolDetails,
	type BashToolParams,
	createBashTool,
	createDefaultTools,
	createEditTool,
	createFileAccessTracker,
	createGlobTool,
	createGrepTool,
	createListDirTool,
	createReadTool,
	createWriteTool,
	type EditToolDetails,
	type EditToolParams,
	type FileAccessTracker,
	type GlobToolDetails,
	type GlobToolParams,
	type GrepToolDetails,
	type GrepToolParams,
	type ListDirToolDetails,
	type ListDirToolParams,
	type ReadToolDetails,
	type ReadToolParams,
	type WriteToolDetails,
	type WriteToolParams,
} from "./tools/index.ts";
