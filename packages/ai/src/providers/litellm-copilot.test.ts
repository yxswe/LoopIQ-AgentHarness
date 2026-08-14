import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLitellmCopilotProvider,
	discoverLitellmCopilotModelIds,
	LITELLM_COPILOT_BASE_URL,
} from "./litellm-copilot.ts";

afterEach(() => vi.unstubAllGlobals());

describe("LiteLLM Copilot provider", () => {
	it("owns the local proxy identity and exposes only discovered supported models", () => {
		const provider = createLitellmCopilotProvider(new Set(["copilot-gpt-5.4", "gpt-5.6-sol"]));
		expect(provider.id).toBe("litellm-copilot");
		expect(provider.getModels().map((model) => model.id)).toEqual(["copilot-gpt-5.4"]);
		expect(provider.getModels()[0]).toMatchObject({
			provider: "litellm-copilot",
			baseUrl: LITELLM_COPILOT_BASE_URL,
			api: "openai-completions",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("discovers proxy model IDs with the supplied master key", async () => {
		const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.headers).toEqual({ Authorization: "Bearer secret" });
			return new Response(JSON.stringify({ data: [{ id: "gpt-5.3-codex" }] }), { status: 200 });
		});
		vi.stubGlobal("fetch", request);

		await expect(discoverLitellmCopilotModelIds("secret")).resolves.toEqual(new Set(["gpt-5.3-codex"]));
		expect(request).toHaveBeenCalledWith(`${LITELLM_COPILOT_BASE_URL}/models`, expect.any(Object));
	});
});
