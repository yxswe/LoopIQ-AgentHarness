// Narrow adapter-facing entry point for the LoopIQ Agent application.

export {
	type Agent,
	type AgentInput,
	type AgentOptions,
	createAgent,
	type RunHandle,
	type RunResult,
	type SessionSnapshot,
	type SteerOptions,
	type UpdateSessionOptions,
} from "./agent.ts";
export type { AgentStreamOptions, QueueMode, ThinkingLevel } from "./base/options.ts";
export type { AbortResult } from "./base/session-types.ts";
export { AgentRuntimeError } from "./base/types.ts";
export type {
	AddProviderCredentialOptions,
	AgentConfiguration,
	AgentConfigurationUpdate,
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
} from "./runtime/event-envelope.ts";
export type { ModelReference } from "./runtime/persisted-session-config.ts";
export type { CreateSessionOptions, SessionSummary } from "./runtime/session-host.ts";
