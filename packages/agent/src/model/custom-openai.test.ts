import { describe, expect, it } from "vitest";
import { createCustomOpenAIProvider } from "./custom-openai.ts";

describe("custom OpenAI-compatible provider", () => {
	it("uses the configured endpoint and model without catalog discovery", () => {
		const provider = createCustomOpenAIProvider({
			baseUrl: "http://host.docker.internal:4000/v1/",
			modelId: "vendor/model-a",
			modelName: "Model A",
			contextWindow: 200_000,
			maxTokens: 32_000,
			reasoning: true,
		});

		expect(provider.id).toBe("custom-openai");
		expect(provider.refreshModels).toBeUndefined();
		expect(provider.getModels()).toHaveLength(1);
		expect(provider.getModels()[0]).toMatchObject({
			id: "vendor/model-a",
			name: "Model A",
			provider: "custom-openai",
			baseUrl: "http://host.docker.internal:4000/v1",
			api: "openai-completions",
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 32_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("uses the Agent-owned Chat Completions compatibility contract", () => {
		const model = createCustomOpenAIProvider({
			baseUrl: "https://example.com/v1",
			modelId: "chat-model",
		}).getModels()[0];

		expect(model).toMatchObject({
			name: "chat-model",
			reasoning: false,
			input: ["text"],
			contextWindow: 128_000,
			maxTokens: 16_384,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsUsageInStreaming: true,
				maxTokensField: "max_tokens",
			},
		});
	});
});
