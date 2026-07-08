import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	Models,
	SimpleStreamOptions,
	ToolResultMessage,
	Transport,
} from "@loopiq/ai";
import type { AgentMessage } from "./messages.ts";
import type {
	AgentHarnessResources,
	AgentTool,
	PromptTemplate,
	Skill,
	ToolExecutionMode,
} from "./resource.ts";
import type { ExecutionEnv, FileOperations } from "./env.ts";
import type { Session } from "../session/session.ts";

/**
 * Stream function used by the agent loop. `Models.streamSimple` satisfies
 * this shape.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;



/**
 * Controls how many queued user messages are injected when the agent loop reaches a queue drain point.
 *
 * - "all": drain and inject every queued message at that point.
 * - "one-at-a-time": drain and inject only the oldest queued message, leaving the rest queued for later drain points.
 */
export type QueueMode = "all" | "one-at-a-time";



/** Context passed to `shouldStopAfterTurn`. */
export interface ShouldStopAfterTurnContext {
	/** The assistant message that completed the turn. */
	message: AssistantMessage;
	/** Tool result messages passed to the preceding `turn_end` event. */
	toolResults: ToolResultMessage[];
	/** Current agent context after the turn's assistant message and tool results have been appended. */
	context: AgentContext;
	/** Messages that this loop invocation will return if it exits at this point. Prompt runs include the initial prompt messages; continuation runs do not include pre-existing context messages. */
	newMessages: AgentMessage[];
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/** Replacement runtime state used by the agent loop before starting another provider request. */
export interface AgentLoopTurnUpdate {
	/** Context for the next provider request. */
	context?: AgentContext;
	/** Model for the next provider request. */
	model?: Model<any>;
	/** Thinking level for the next provider request. */
	thinkingLevel?: ThinkingLevel;
}



/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
	/** Preferred transport forwarded to the stream function. */
	transport?: Transport;
	/** Provider request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum provider retry attempts. */
	maxRetries?: number;
	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;
	/** Additional request headers merged with auth and lifecycle headers. */
	headers?: Record<string, string>;
	/** Provider metadata forwarded with requests. */
	metadata?: SimpleStreamOptions["metadata"];
	/** Provider cache retention hint. */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** Per-request stream option patch returned by provider hooks. */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** Header patch. `undefined` values delete keys; explicit `headers: undefined` clears all headers. */
	headers?: Record<string, string | undefined>;
	/** Metadata patch. `undefined` values delete keys; explicit `metadata: undefined` clears all metadata. */
	metadata?: Record<string, unknown | undefined>;
}

export interface AgentHarnessOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	env: ExecutionEnv;
	session: Session;
	/**
	 * Provider collection used for all model requests (turn streaming,
	 * compaction, branch summarization). Auth resolves through the providers'
	 * auth.
	 */
	models: Models;
	tools?: TTool[];
	/**
	 * Concrete resources available to explicit invocation methods and system-prompt callbacks.
	 * Applications own loading/reloading resources and should call `setResources()` with new values.
	 */
	resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
	systemPrompt?:
		| string
		| ((context: {
				env: ExecutionEnv;
				session: Session;
				model: Model<any>;
				thinkingLevel: ThinkingLevel;
				activeTools: TTool[];
				resources: AgentHarnessResources<TSkill, TPromptTemplate>;
		  }) => string | Promise<string>);
	/** Curated stream/provider request options. Snapshotted at turn start. */
	streamOptions?: AgentHarnessStreamOptions;
	model: Model<any>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by selected model families. Use model thinking-level metadata
 * from @loopiq/ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";



/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}



