import type { ModelReference, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";
import { AgentRuntimeError } from "../base/types.ts";
import type { AgentConfiguration, AgentConfigurationUpdate } from "./agent-configuration.ts";
import type { FileAgentSettingsStore } from "./file-agent-settings-store.ts";

export class AgentSettings {
	private configuration: AgentConfiguration;
	private readonly store: FileAgentSettingsStore;
	private readonly validateModelReference: (reference: ModelReference) => Promise<unknown>;

	constructor(
		configuration: AgentConfiguration,
		store: FileAgentSettingsStore,
		validateModelReference: (reference: ModelReference) => Promise<unknown>,
	) {
		this.configuration = structuredClone(configuration);
		this.store = store;
		this.validateModelReference = validateModelReference;
	}

	getSnapshot(): AgentConfiguration {
		return structuredClone(this.configuration);
	}

	getSessionDefaults(): { model: ModelReference; thinkingLevel: ThinkingLevel } {
		return {
			model: structuredClone(this.configuration.defaultModel),
			thinkingLevel: this.configuration.defaultThinkingLevel,
		};
	}

	getProviderRequestPolicy(): ProviderRequestPolicy {
		return { ...this.configuration.providerRequest };
	}

	async update(update: AgentConfigurationUpdate): Promise<AgentConfiguration> {
		if (update.defaultModel) await this.validateModelReference(update.defaultModel);
		if (
			update.defaultThinkingLevel !== undefined &&
			!["off", "minimal", "low", "medium", "high", "xhigh"].includes(update.defaultThinkingLevel as string)
		) {
			throw new AgentRuntimeError(
				"invalid_argument",
				`Invalid default thinking level ${update.defaultThinkingLevel}`,
			);
		}
		const nextConfiguration: AgentConfiguration = {
			defaultModel: structuredClone(update.defaultModel ?? this.configuration.defaultModel),
			defaultThinkingLevel: update.defaultThinkingLevel ?? this.configuration.defaultThinkingLevel,
			providerRequest: this.mergeProviderRequestPolicy(update.providerRequest),
		};
		this.configuration = await this.store.update(nextConfiguration);
		return this.getSnapshot();
	}

	private mergeProviderRequestPolicy(update?: Partial<ProviderRequestPolicy>): ProviderRequestPolicy {
		if (
			update &&
			Object.keys(update).some(
				(key) =>
					key !== "transport" &&
					key !== "timeoutMs" &&
					key !== "maxRetries" &&
					key !== "maxRetryDelayMs" &&
					key !== "cacheRetention",
			)
		) {
			throw new AgentRuntimeError("invalid_argument", "providerRequest contains an unsupported field");
		}
		const policy = { ...this.configuration.providerRequest, ...update };
		if (!(["sse", "websocket", "websocket-cached", "auto"] as string[]).includes(policy.transport)) {
			throw new AgentRuntimeError("invalid_argument", `Invalid provider request transport ${policy.transport}`);
		}
		if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs <= 0) {
			throw new AgentRuntimeError("invalid_argument", "providerRequest.timeoutMs must be a positive integer");
		}
		if (!Number.isInteger(policy.maxRetries) || policy.maxRetries < 0) {
			throw new AgentRuntimeError("invalid_argument", "providerRequest.maxRetries must be a non-negative integer");
		}
		if (!Number.isInteger(policy.maxRetryDelayMs) || policy.maxRetryDelayMs < 0) {
			throw new AgentRuntimeError(
				"invalid_argument",
				"providerRequest.maxRetryDelayMs must be a non-negative integer",
			);
		}
		if (!(["none", "short", "long"] as string[]).includes(policy.cacheRetention)) {
			throw new AgentRuntimeError(
				"invalid_argument",
				`Invalid provider request cache retention ${policy.cacheRetention}`,
			);
		}
		return policy;
	}
}
