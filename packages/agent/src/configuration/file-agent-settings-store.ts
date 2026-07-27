import { join } from "node:path";
import { AgentRuntimeError, toError } from "../base/types.ts";
import { withFileLock } from "../persistence/file-lock.ts";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/json-file.ts";
import type { AgentConfiguration } from "./agent-configuration.ts";

function isAgentConfiguration(value: unknown): value is AgentConfiguration {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) => key !== "defaultModel" && key !== "defaultThinkingLevel" && key !== "providerRequest",
		)
	)
		return false;
	const model = record.defaultModel;
	const providerRequest = record.providerRequest;
	return Boolean(
		model &&
			typeof model === "object" &&
			!Array.isArray(model) &&
			typeof (model as Record<string, unknown>).providerId === "string" &&
			typeof (model as Record<string, unknown>).modelId === "string" &&
			Object.keys(model).every((key) => key === "providerId" || key === "modelId") &&
			typeof record.defaultThinkingLevel === "string" &&
			["off", "minimal", "low", "medium", "high", "xhigh"].includes(record.defaultThinkingLevel) &&
			providerRequest &&
			typeof providerRequest === "object" &&
			!Array.isArray(providerRequest) &&
			Object.keys(providerRequest).every((key) =>
				["transport", "timeoutMs", "maxRetries", "maxRetryDelayMs", "cacheRetention"].includes(key),
			) &&
			["sse", "websocket", "websocket-cached", "auto"].includes(
				(providerRequest as Record<string, unknown>).transport as string,
			) &&
			Number.isInteger((providerRequest as Record<string, unknown>).timeoutMs) &&
			((providerRequest as Record<string, number>).timeoutMs ?? 0) > 0 &&
			Number.isInteger((providerRequest as Record<string, unknown>).maxRetries) &&
			((providerRequest as Record<string, number>).maxRetries ?? -1) >= 0 &&
			Number.isInteger((providerRequest as Record<string, unknown>).maxRetryDelayMs) &&
			((providerRequest as Record<string, number>).maxRetryDelayMs ?? -1) >= 0 &&
			["none", "short", "long"].includes((providerRequest as Record<string, unknown>).cacheRetention as string),
	);
}

export class FileAgentSettingsStore {
	private readonly filePath: string;
	private readonly lockPath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "agent.json");
		this.lockPath = join(dataDir, "agent.lock");
	}

	async loadOrCreate(defaults: AgentConfiguration): Promise<AgentConfiguration> {
		return withFileLock(this.lockPath, async () => {
			const current = await this.read();
			if (current) return current;
			await this.write(defaults);
			return structuredClone(defaults);
		});
	}

	async update(configuration: AgentConfiguration): Promise<AgentConfiguration> {
		return withFileLock(this.lockPath, async () => {
			await this.write(configuration);
			return structuredClone(configuration);
		});
	}

	private async read(): Promise<AgentConfiguration | undefined> {
		try {
			const value = await readJsonFile<unknown>(this.filePath);
			if (value === undefined) return undefined;
			if (!isAgentConfiguration(value)) throw new Error("Agent settings contain an unsupported shape");
			return value;
		} catch (error) {
			throw new AgentRuntimeError("agent_configuration", "Failed to read Agent settings", toError(error));
		}
	}

	private async write(configuration: AgentConfiguration): Promise<void> {
		try {
			await writeJsonFileAtomic(this.filePath, configuration);
		} catch (error) {
			throw new AgentRuntimeError("agent_configuration", "Failed to save Agent settings", toError(error));
		}
	}
}
