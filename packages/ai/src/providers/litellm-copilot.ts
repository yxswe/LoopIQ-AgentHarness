import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import type { Model } from "../types.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

export const LITELLM_COPILOT_PROVIDER_ID = "litellm-copilot";
export const LITELLM_COPILOT_BASE_URL = "http://host.docker.internal:4000/v1";

const MODEL_SOURCES = [
	["github_copilot/gpt-4.1", GITHUB_COPILOT_MODELS["gpt-4.1"]],
	["github_copilot/gpt-5-mini", GITHUB_COPILOT_MODELS["gpt-5-mini"]],
] as const;

const MODELS = [
	...MODEL_SOURCES.map(([id, source]) => ({
		...source,
		id,
		api: "openai-completions" as const,
		provider: LITELLM_COPILOT_PROVIDER_ID,
		baseUrl: LITELLM_COPILOT_BASE_URL,
		headers: undefined,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: source.reasoning,
			supportsUsageInStreaming: true,
			supportsLongCacheRetention: false,
		},
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	})),
	{
		...GITHUB_COPILOT_MODELS["gpt-5.5"],
		id: "gpt-5.6-sol",
		name: "GPT-5.6 SOL",
		api: "openai-completions",
		provider: LITELLM_COPILOT_PROVIDER_ID,
		baseUrl: LITELLM_COPILOT_BASE_URL,
		headers: undefined,
		reasoning: true,
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsLongCacheRetention: false,
		},
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
] satisfies readonly Model<"openai-completions">[];

export function createLitellmCopilotProvider(availableModelIds?: ReadonlySet<string>): Provider<"openai-completions"> {
	return createProvider({
		id: LITELLM_COPILOT_PROVIDER_ID,
		name: "Local LiteLLM Copilot",
		baseUrl: LITELLM_COPILOT_BASE_URL,
		auth: { apiKey: envApiKeyAuth("LiteLLM master key", ["LITELLM_MASTER_KEY"]) },
		models: availableModelIds ? MODELS.filter((model) => availableModelIds.has(model.id)) : MODELS,
		api: openAICompletionsApi(),
	});
}

export async function discoverLitellmCopilotModelIds(apiKey: string, signal?: AbortSignal): Promise<Set<string>> {
	const response = await fetch(`${LITELLM_COPILOT_BASE_URL}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal,
	});
	if (!response.ok) throw new Error(`LiteLLM model discovery failed with HTTP ${response.status}`);
	const payload: unknown = await response.json();
	if (!isModelList(payload)) throw new Error("LiteLLM model discovery returned an unsupported response");
	return new Set(payload.data.map((model) => model.id));
}

function isModelList(value: unknown): value is { data: { id: string }[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { data?: unknown }).data) &&
		(value as { data: unknown[] }).data.every(
			(model) => typeof model === "object" && model !== null && typeof (model as { id?: unknown }).id === "string",
		)
	);
}
