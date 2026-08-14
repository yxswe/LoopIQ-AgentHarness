import { createProvider, envApiKeyAuth, type Model, type Provider } from "@loopiq/ai";
import { openAICompletionsApi } from "@loopiq/ai/api/openai-completions.lazy";
import { GITHUB_COPILOT_MODELS } from "@loopiq/ai/providers/github-copilot.models";
import { OPENAI_MODELS } from "@loopiq/ai/providers/openai.models";

export const LITELLM_COPILOT_PROVIDER_ID = "litellm-copilot";
export const LITELLM_COPILOT_BASE_URL = "http://host.docker.internal:4000/v1";

const MODEL_SOURCES = [
	["copilot-gpt-4o", OPENAI_MODELS["gpt-4o"]],
	["copilot-gpt-5.4", GITHUB_COPILOT_MODELS["gpt-5.4"]],
	["claude-sonnet-5", GITHUB_COPILOT_MODELS["claude-sonnet-5"]],
	["claude-opus-4.8", GITHUB_COPILOT_MODELS["claude-opus-4.8"]],
	["claude-haiku-4.5", GITHUB_COPILOT_MODELS["claude-haiku-4.5"]],
	["gpt-5.5", GITHUB_COPILOT_MODELS["gpt-5.5"]],
	["gpt-5.3-codex", GITHUB_COPILOT_MODELS["gpt-5.3-codex"]],
] as const;

const MODELS: readonly Model<"openai-completions">[] = MODEL_SOURCES.map(([id, source]) => ({
	...source,
	id,
	api: "openai-completions",
	provider: LITELLM_COPILOT_PROVIDER_ID,
	baseUrl: LITELLM_COPILOT_BASE_URL,
	headers: undefined,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		supportsLongCacheRetention: false,
	},
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

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
