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
			(key) =>
				key !== "defaultModel" &&
				key !== "defaultThinkingLevel" &&
				key !== "providerRequest" &&
				key !== "customProvider",
		)
	)
		return false;
	const model = record.defaultModel;
	const providerRequest = record.providerRequest;
	const customProvider = record.customProvider;
	return Boolean(
		(model === undefined ||
			(typeof model === "object" &&
				model !== null &&
				!Array.isArray(model) &&
				typeof (model as Record<string, unknown>).providerId === "string" &&
				typeof (model as Record<string, unknown>).modelId === "string" &&
				Object.keys(model).every((key) => key === "providerId" || key === "modelId"))) &&
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
			["none", "short", "long"].includes((providerRequest as Record<string, unknown>).cacheRetention as string) &&
			(customProvider === undefined || isCustomProviderConfiguration(customProvider)),
	);
}

function isCustomProviderConfiguration(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) =>
				key !== "baseUrl" &&
				key !== "modelId" &&
				key !== "modelName" &&
				key !== "contextWindow" &&
				key !== "maxTokens" &&
				key !== "reasoning",
		)
	)
		return false;
	if (!isNonEmptyString(record.modelId)) return false;
	if (record.modelName !== undefined && !isNonEmptyString(record.modelName)) return false;
	if (record.reasoning !== undefined && typeof record.reasoning !== "boolean") return false;
	if (record.contextWindow !== undefined && !isPositiveInteger(record.contextWindow)) return false;
	if (record.maxTokens !== undefined && !isPositiveInteger(record.maxTokens)) return false;
	if (
		typeof record.contextWindow === "number" &&
		typeof record.maxTokens === "number" &&
		record.maxTokens > record.contextWindow
	)
		return false;
	if (!isNonEmptyString(record.baseUrl) || record.baseUrl !== record.baseUrl.trim()) return false;
	try {
		const url = new URL(record.baseUrl);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && (value as number) > 0;
}

export class FileAgentSettingsStore {
	private readonly filePath: string;
	private readonly lockPath: string;

	constructor(agentHome: string) {
		this.filePath = join(agentHome, "agent.json");
		this.lockPath = join(agentHome, "agent.lock");
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
