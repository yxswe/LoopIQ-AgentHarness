import type { Model } from "@loopiq/ai";
import type { ExecutionEnv } from "./env.ts";
import type { AgentMessage } from "./messages.ts";
import type { AgentResources, AgentTool } from "./resource.ts";

export interface ModelReference {
	providerId: string;
	modelId: string;
}

/** Safe, serializable Agent policy applied to every provider request. */
export type ProviderTransport = "sse" | "websocket" | "websocket-cached" | "auto";
export type ProviderCacheRetention = "none" | "short" | "long";

export interface ProviderRequestPolicy {
	/** Preferred transport for providers that support more than one transport. */
	transport: ProviderTransport;
	/** Provider request timeout in milliseconds. */
	timeoutMs: number;
	/** Maximum provider/SDK retry attempts. */
	maxRetries: number;
	/** Maximum server-requested retry delay. Zero disables the cap. */
	maxRetryDelayMs: number;
	/** Provider prompt-cache retention preference. */
	cacheRetention: ProviderCacheRetention;
}

/** Compiled policy used when agent.json does not exist yet. */
export const DEFAULT_PROVIDER_REQUEST_POLICY: ProviderRequestPolicy = {
	transport: "auto",
	timeoutMs: 300_000,
	maxRetries: 0,
	maxRetryDelayMs: 60_000,
	cacheRetention: "short",
};

export type AgentSystemPrompt =
	| string
	| ((context: {
			env: ExecutionEnv;
			sessionId: string;
			model: Model<any>;
			thinkingLevel: ThinkingLevel;
			tools: AgentTool[];
			resources: AgentResources;
	  }) => string | Promise<string>);

/**
 * Thinking/reasoning level for models that support it.
 * Note: "xhigh" is only supported by selected model families. Use model thinking-level metadata
 * from @loopiq/ai to detect support for a concrete model.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type SessionConfiguration = {
	model: ModelReference;
	thinkingLevel: ThinkingLevel;
};

/** Context snapshot passed into the low-level agent loop. */
export interface AgentContext {
	/** System prompt included with the request. */
	systemPrompt: string;
	/** Transcript visible to the model. */
	messages: AgentMessage[];
	/** Tools available for this run. */
	tools?: AgentTool<any>[];
}
