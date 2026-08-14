import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";

export const CUSTOM_OPENAI_PROVIDER_ID = "custom-openai";

export interface CustomOpenAIProviderOptions {
	baseUrl: string;
	modelId: string;
	modelName?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export function createCustomOpenAIProvider(options: CustomOpenAIProviderOptions): Provider<"openai-completions"> {
	const baseUrl = options.baseUrl.replace(/\/+$/, "");
	const model: Model<"openai-completions"> = {
		id: options.modelId,
		name: options.modelName ?? options.modelId,
		api: "openai-completions",
		provider: CUSTOM_OPENAI_PROVIDER_ID,
		baseUrl,
		reasoning: options.reasoning ?? false,
		input: ["text"],
		contextWindow: options.contextWindow ?? 128_000,
		maxTokens: options.maxTokens ?? 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			supportsLongCacheRetention: false,
		},
	};

	return createProvider({
		id: CUSTOM_OPENAI_PROVIDER_ID,
		name: "Custom OpenAI-compatible API",
		baseUrl,
		auth: { apiKey: envApiKeyAuth("custom API key", ["CUSTOM_OPENAI_API_KEY"]) },
		models: [model],
		api: openAICompletionsApi(),
	});
}
