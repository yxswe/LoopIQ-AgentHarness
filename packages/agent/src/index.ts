// Narrow adapter-facing entry point for the LoopIQ Agent application.

export type {
	Agent,
	AgentInput,
	AgentOptions,
	CreateSessionOptions,
	RunHandle,
	RunResult,
	SessionSnapshot,
	SessionSummary,
	SteerOptions,
	UpdateSessionOptions,
} from "./agent.ts";
export type {
	ModelReference,
	ProviderCacheRetention,
	ProviderRequestPolicy,
	ProviderTransport,
	ThinkingLevel,
} from "./base/options.ts";
export { AgentRuntimeError } from "./base/types.ts";
export type { AgentConfiguration, AgentConfigurationUpdate } from "./configuration/agent-configuration.ts";
export { createAgent } from "./create-agent.ts";
export type {
	AddProviderCredentialOptions,
	ListModelsOptions,
	ListProvidersOptions,
	ModelSummary,
	ProviderAuthEvent,
	ProviderAuthMethod,
	ProviderAuthPrompt,
	ProviderCredentialState,
	ProviderLoginInteraction,
	ProviderStatus,
	ProviderSummary,
} from "./model/provider-types.ts";
export type {
	AgentEventEnvelope,
	AgentEventListener,
	RunSettledEvent,
	SerializedRunError,
} from "./session/event-envelope.ts";
export type { AbortResult } from "./session/session-contracts.ts";
