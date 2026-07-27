import type { ModelReference, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";

export interface AgentConfiguration {
	defaultModel: ModelReference;
	defaultThinkingLevel: ThinkingLevel;
	providerRequest: ProviderRequestPolicy;
}

export interface AgentConfigurationUpdate {
	defaultModel?: ModelReference;
	defaultThinkingLevel?: ThinkingLevel;
	providerRequest?: Partial<ProviderRequestPolicy>;
}
