import type { ModelReference, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";

export interface CustomProviderConfiguration {
	baseUrl: string;
	modelId: string;
	modelName?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface AgentConfiguration {
	defaultModel?: ModelReference;
	defaultThinkingLevel: ThinkingLevel;
	providerRequest: ProviderRequestPolicy;
	customProvider?: CustomProviderConfiguration;
}

export interface AgentConfigurationUpdate {
	defaultModel?: ModelReference;
	defaultThinkingLevel?: ThinkingLevel;
	providerRequest?: Partial<ProviderRequestPolicy>;
}
