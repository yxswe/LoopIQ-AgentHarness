import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_REQUEST_POLICY } from "../base/options.ts";
import type { AgentConfiguration } from "./agent-configuration.ts";
import { FileAgentSettingsStore } from "./file-agent-settings-store.ts";

const agentHomes: string[] = [];
const DEFAULT_CONFIGURATION: AgentConfiguration = {
	defaultThinkingLevel: "high",
	providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
};

afterEach(async () => {
	await Promise.all(agentHomes.splice(0).map((agentHome) => rm(agentHome, { recursive: true, force: true })));
});

async function writeConfiguration(customProvider: Record<string, unknown>): Promise<FileAgentSettingsStore> {
	const agentHome = await mkdtemp(join(tmpdir(), "loopiq-agent-settings-"));
	agentHomes.push(agentHome);
	await writeFile(
		join(agentHome, "agent.json"),
		JSON.stringify({
			defaultThinkingLevel: "high",
			providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
			customProvider,
		}),
	);
	return new FileAgentSettingsStore(agentHome);
}

describe("FileAgentSettingsStore custom Provider configuration", () => {
	it("loads a strict non-secret endpoint and model definition", async () => {
		const store = await writeConfiguration({
			baseUrl: "https://example.com/v1",
			modelId: "vendor/model-a",
			modelName: "Model A",
			contextWindow: 200_000,
			maxTokens: 32_000,
			reasoning: true,
		});

		expect((await store.loadOrCreate(DEFAULT_CONFIGURATION)).customProvider).toEqual({
			baseUrl: "https://example.com/v1",
			modelId: "vendor/model-a",
			modelName: "Model A",
			contextWindow: 200_000,
			maxTokens: 32_000,
			reasoning: true,
		});
	});

	it.each([
		{ baseUrl: "file:///tmp/api", modelId: "model-a" },
		{ baseUrl: "https://user:secret@example.com/v1", modelId: "model-a" },
		{ baseUrl: "https://example.com/v1?api_key=secret", modelId: "model-a" },
		{ baseUrl: "https://example.com/v1", modelId: "model-a", apiKey: "secret" },
		{ baseUrl: "https://example.com/v1", modelId: "model-a", contextWindow: 100, maxTokens: 101 },
	])("rejects unsupported or sensitive fields: $baseUrl", async (customProvider) => {
		const store = await writeConfiguration(customProvider);

		await expect(store.loadOrCreate(DEFAULT_CONFIGURATION)).rejects.toMatchObject({ code: "agent_configuration" });
	});
});
