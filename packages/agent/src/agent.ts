import type { AgentStreamOptions, QueueMode, ThinkingLevel } from "./base/options.ts";
import type { AbortResult } from "./base/session-types.ts";
import { AgentRuntimeError } from "./base/types.ts";
import type { AgentUserInput } from "./engine/agent-run.ts";
import { ModelRuntime } from "./model/model-runtime.ts";
import type {
	AddProviderCredentialOptions,
	AgentConfiguration,
	AgentConfigurationUpdate,
	ListModelsOptions,
	ListProvidersOptions,
	ModelSummary,
	ProviderStatus,
	ProviderSummary,
} from "./model/provider-types.ts";
import { NodeAgentSettingsStore } from "./node/node-agent-settings-store.ts";
import { NodeCredentialStore } from "./node/node-credential-store.ts";
import { NodeSessionHost } from "./node/node-session-host.ts";
import type {
	AgentRunHandle,
	AgentRunResult,
	AgentSessionSnapshot,
	AgentSteerOptions,
} from "./runtime/agent-session.ts";
import type { AgentEventListener } from "./runtime/event-envelope.ts";
import type { ModelReference } from "./runtime/persisted-session-config.ts";
import type { CreateSessionOptions, SessionSummary } from "./runtime/session-host.ts";
import { createDefaultTools } from "./tools/index.ts";

const COMPILED_DEFAULT_CONFIGURATION: AgentConfiguration = {
	defaultModel: { providerId: "github-copilot", modelId: "claude-opus-4.6" },
};

const AGENT_SYSTEM_PROMPT = "You are a helpful coding agent running inside LoopIQ Agent.";

export type AgentInput = AgentUserInput;
export type RunHandle = AgentRunHandle;
export type RunResult = AgentRunResult;
export type SessionSnapshot = AgentSessionSnapshot;
export type SteerOptions = AgentSteerOptions;

export interface AgentOptions {
	dataDir: string;
}

export interface UpdateSessionOptions {
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
}

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

interface AgentImplOptions {
	dataDir: string;
	modelRuntime: ModelRuntime;
	configuration: AgentConfiguration;
	settingsStore: NodeAgentSettingsStore;
	defaultThinkingLevel?: ThinkingLevel;
	streamOptions?: AgentStreamOptions;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

class AgentImpl implements Agent {
	private configuration: AgentConfiguration;
	private readonly modelRuntime: ModelRuntime;
	private readonly settingsStore: NodeAgentSettingsStore;
	private readonly sessions: NodeSessionHost;
	private readonly providerUseCounts = new Map<string, number>();
	private readonly providerMutations = new Set<string>();

	constructor(options: AgentImplOptions) {
		this.configuration = structuredClone(options.configuration);
		this.modelRuntime = options.modelRuntime;
		this.settingsStore = options.settingsStore;
		this.sessions = new NodeSessionHost({
			dataDir: options.dataDir,
			models: options.modelRuntime.models,
			defaultModel: this.configuration.defaultModel,
			defaultThinkingLevel: options.defaultThinkingLevel,
			systemPrompt: AGENT_SYSTEM_PROMPT,
			streamOptions: options.streamOptions,
			steeringMode: options.steeringMode,
			followUpMode: options.followUpMode,
			createTools: (env) => createDefaultTools(env),
		});
	}

	async createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
		return (
			await this.sessions.create({
				...options,
				model: options.model ?? this.configuration.defaultModel,
			})
		).getSnapshot();
	}

	async getSession(sessionId: string): Promise<SessionSnapshot> {
		return (await this.sessions.open(sessionId)).getSnapshot();
	}

	listSessions(): Promise<SessionSummary[]> {
		return this.sessions.list();
	}

	async updateSession(sessionId: string, options: UpdateSessionOptions): Promise<SessionSnapshot> {
		const session = await this.sessions.open(sessionId);
		if (options.model) {
			const status = await this.modelRuntime.validateProviderCredential(options.model.providerId);
			this.requireValidProvider(status);
			await session.setModel(await this.modelRuntime.resolveModel(options.model));
		}
		if (options.thinkingLevel !== undefined) await session.setThinkingLevel(options.thinkingLevel);
		return session.getSnapshot();
	}

	async closeSession(sessionId: string): Promise<void> {
		await this.sessions.close(sessionId);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.sessions.delete(sessionId);
	}

	async run(sessionId: string, input: AgentInput): Promise<RunHandle> {
		const session = await this.sessions.open(sessionId);
		while (true) {
			const model = session.getSnapshot().model;
			const providerId = model.providerId;
			this.beginProviderUse(providerId);
			try {
				await this.modelRuntime.requireUsableCredential(model);
				const currentModel = session.getSnapshot().model;
				if (currentModel.providerId !== model.providerId || currentModel.modelId !== model.modelId) {
					this.endProviderUse(providerId);
					continue;
				}
				const handle = session.startRun(input);
				void handle.result.then(
					() => this.endProviderUse(providerId),
					() => this.endProviderUse(providerId),
				);
				return handle;
			} catch (error) {
				this.endProviderUse(providerId);
				throw error;
			}
		}
	}

	async steer(sessionId: string, runId: string, input: AgentInput, options?: SteerOptions): Promise<void> {
		await (await this.sessions.open(sessionId)).steer(runId, input, options);
	}

	async abort(sessionId: string, runId: string): Promise<AbortResult> {
		return (await this.sessions.open(sessionId)).abort(runId);
	}

	async subscribe(sessionId: string, listener: AgentEventListener): Promise<() => void> {
		return (await this.sessions.open(sessionId)).subscribe(listener);
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

	async addProviderCredential(providerId: string, options: AddProviderCredentialOptions): Promise<ProviderStatus> {
		this.beginProviderMutation(providerId);
		try {
			return await this.modelRuntime.addProviderCredential(providerId, options);
		} finally {
			this.providerMutations.delete(providerId);
		}
	}

	validateProviderCredential(providerId: string): Promise<ProviderStatus> {
		return this.modelRuntime.validateProviderCredential(providerId, true);
	}

	async removeProviderCredential(providerId: string): Promise<void> {
		this.beginProviderMutation(providerId);
		try {
			await this.modelRuntime.removeProviderCredential(providerId);
		} finally {
			this.providerMutations.delete(providerId);
		}
	}

	async getConfiguration(): Promise<AgentConfiguration> {
		return structuredClone(this.configuration);
	}

	async updateConfiguration(update: AgentConfigurationUpdate): Promise<AgentConfiguration> {
		await this.modelRuntime.resolveModel(update.defaultModel);
		this.configuration = await this.settingsStore.update({ defaultModel: structuredClone(update.defaultModel) });
		this.sessions.setDefaultModel(this.configuration.defaultModel);
		return structuredClone(this.configuration);
	}

	shutdown(options?: { abortRunning?: boolean }): Promise<void> {
		return this.sessions.shutdown(options);
	}

	private beginProviderUse(providerId: string): void {
		if (this.providerMutations.has(providerId)) {
			throw new AgentRuntimeError("provider_busy", `Provider ${providerId} has a credential mutation in progress`);
		}
		this.providerUseCounts.set(providerId, (this.providerUseCounts.get(providerId) ?? 0) + 1);
	}

	private endProviderUse(providerId: string): void {
		const count = this.providerUseCounts.get(providerId);
		if (count === undefined || count <= 1) this.providerUseCounts.delete(providerId);
		else this.providerUseCounts.set(providerId, count - 1);
	}

	private beginProviderMutation(providerId: string): void {
		if (
			this.providerMutations.has(providerId) ||
			(this.providerUseCounts.get(providerId) ?? 0) > 0 ||
			this.sessions.hasActiveRunForProvider(providerId)
		) {
			throw new AgentRuntimeError("provider_busy", `Provider ${providerId} is used by an active run`);
		}
		this.providerMutations.add(providerId);
	}

	private requireValidProvider(status: ProviderStatus): void {
		if (status.credentialState === "valid") return;
		if (status.credentialState === "missing" || status.credentialState === "unchecked") {
			throw new AgentRuntimeError(
				"provider_auth_required",
				`Provider ${status.providerId} requires a valid credential`,
			);
		}
		if (status.credentialState === "invalid") {
			throw new AgentRuntimeError(
				"provider_credential_invalid",
				status.message ?? `Provider ${status.providerId} rejected its credential`,
			);
		}
		throw new AgentRuntimeError(
			"provider_validation_unavailable",
			status.message ?? `Could not validate provider ${status.providerId}`,
		);
	}
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
	const settingsStore = new NodeAgentSettingsStore(options.dataDir);
	const configuration = await settingsStore.loadOrCreate(COMPILED_DEFAULT_CONFIGURATION);
	const modelRuntime = new ModelRuntime({ credentials: new NodeCredentialStore(options.dataDir) });
	await modelRuntime.resolveModel(configuration.defaultModel, false);
	return new AgentImpl({ dataDir: options.dataDir, modelRuntime, configuration, settingsStore });
}

export async function createAgentForTesting(options: {
	dataDir: string;
	modelRuntime: ModelRuntime;
	defaultModel: ModelReference;
}): Promise<Agent> {
	const settingsStore = new NodeAgentSettingsStore(options.dataDir);
	const configuration = await settingsStore.loadOrCreate({ defaultModel: options.defaultModel });
	return new AgentImpl({
		dataDir: options.dataDir,
		modelRuntime: options.modelRuntime,
		configuration,
		settingsStore,
	});
}
