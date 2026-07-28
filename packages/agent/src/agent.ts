import type { AgentConfiguration, AgentConfigurationUpdate } from "./configuration/agent-configuration.ts";
import type { AgentSettings } from "./configuration/agent-settings.ts";
import type { AgentUserInput } from "./engine/agent-run.ts";
import type { ModelRuntime } from "./model/model-runtime.ts";
import type {
	AddProviderCredentialOptions,
	ListModelsOptions,
	ListProvidersOptions,
	ModelSummary,
	ProviderStatus,
	ProviderSummary,
} from "./model/provider-types.ts";
import type { AgentSessionManager } from "./session/agent-session-manager.ts";
import type { AgentEventListener } from "./session/event-envelope.ts";
import type {
	AbortResult,
	CreateSessionOptions,
	RunHandle,
	RunResult,
	SessionSnapshot,
	SessionSummary,
	SteerOptions,
	UpdateSessionOptions,
} from "./session/session-contracts.ts";

export type AgentInput = AgentUserInput;
export type {
	CreateSessionOptions,
	RunHandle,
	RunResult,
	SessionSnapshot,
	SessionSummary,
	SteerOptions,
	UpdateSessionOptions,
};

export interface Agent {
	createSession(options: CreateSessionOptions): Promise<SessionSnapshot>;
	getSession(sessionId: string): Promise<SessionSnapshot>;
	listSessions(): Promise<SessionSummary[]>;
	updateSession(sessionId: string, options: UpdateSessionOptions): Promise<SessionSnapshot>;
	closeSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	run(sessionId: string, input: AgentInput): Promise<RunHandle>;
	steer(sessionId: string, runId: string, input: AgentInput, options?: SteerOptions): Promise<void>;
	abort(sessionId: string, runId: string): Promise<AbortResult>;
	subscribe(sessionId: string, listener: AgentEventListener): Promise<() => void>;
	listProviders(options?: ListProvidersOptions): Promise<ProviderSummary[]>;
	listModels(providerId?: string, options?: ListModelsOptions): Promise<ModelSummary[]>;
	getProviderStatus(providerId: string): Promise<ProviderStatus>;
	addProviderCredential(providerId: string, options: AddProviderCredentialOptions): Promise<ProviderStatus>;
	validateProviderCredential(providerId: string): Promise<ProviderStatus>;
	removeProviderCredential(providerId: string): Promise<void>;
	getConfiguration(): Promise<AgentConfiguration>;
	updateConfiguration(update: AgentConfigurationUpdate): Promise<AgentConfiguration>;
	shutdown(options?: { abortRunning?: boolean }): Promise<void>;
}

interface AgentFacadeDependencies {
	modelRuntime: ModelRuntime;
	sessions: AgentSessionManager;
	settings: AgentSettings;
}

export function createAgentFacade(dependencies: AgentFacadeDependencies): Agent {
	return new AgentFacade(dependencies);
}

class AgentFacade implements Agent {
	private readonly modelRuntime: ModelRuntime;
	private readonly sessions: AgentSessionManager;
	private readonly settings: AgentSettings;

	constructor(dependencies: AgentFacadeDependencies) {
		this.modelRuntime = dependencies.modelRuntime;
		this.sessions = dependencies.sessions;
		this.settings = dependencies.settings;
	}

	createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
		return this.sessions.createSession(options);
	}

	getSession(sessionId: string): Promise<SessionSnapshot> {
		return this.sessions.getSession(sessionId);
	}

	listSessions(): Promise<SessionSummary[]> {
		return this.sessions.listSessions();
	}

	updateSession(sessionId: string, options: UpdateSessionOptions): Promise<SessionSnapshot> {
		return this.sessions.updateSession(sessionId, options);
	}

	closeSession(sessionId: string): Promise<void> {
		return this.sessions.close(sessionId);
	}

	deleteSession(sessionId: string): Promise<void> {
		return this.sessions.delete(sessionId);
	}

	run(sessionId: string, input: AgentInput): Promise<RunHandle> {
		return this.sessions.run(sessionId, input);
	}

	steer(sessionId: string, runId: string, input: AgentInput, options?: SteerOptions): Promise<void> {
		return this.sessions.steer(sessionId, runId, input, options);
	}

	abort(sessionId: string, runId: string): Promise<AbortResult> {
		return this.sessions.abort(sessionId, runId);
	}

	subscribe(sessionId: string, listener: AgentEventListener): Promise<() => void> {
		return this.sessions.subscribe(sessionId, listener);
	}

	listProviders(options?: ListProvidersOptions): Promise<ProviderSummary[]> {
		return this.modelRuntime.listProviders(options);
	}

	listModels(providerId?: string, options?: ListModelsOptions): Promise<ModelSummary[]> {
		return this.modelRuntime.listModels(providerId, options);
	}

	getProviderStatus(providerId: string): Promise<ProviderStatus> {
		return this.modelRuntime.getProviderStatus(providerId);
	}

	addProviderCredential(providerId: string, options: AddProviderCredentialOptions): Promise<ProviderStatus> {
		return this.modelRuntime.addProviderCredential(providerId, options);
	}

	validateProviderCredential(providerId: string): Promise<ProviderStatus> {
		return this.modelRuntime.validateProviderCredential(providerId, true);
	}

	removeProviderCredential(providerId: string): Promise<void> {
		return this.modelRuntime.removeProviderCredential(providerId);
	}

	async getConfiguration(): Promise<AgentConfiguration> {
		return this.settings.getSnapshot();
	}

	updateConfiguration(update: AgentConfigurationUpdate): Promise<AgentConfiguration> {
		return this.settings.update(update);
	}

	shutdown(options?: { abortRunning?: boolean }): Promise<void> {
		return this.sessions.shutdown(options);
	}
}
