import type { Provider } from "@loopiq/ai";
import { anthropicProvider } from "@loopiq/ai/providers/anthropic";
import { deepseekProvider } from "@loopiq/ai/providers/deepseek";
import { githubCopilotProvider } from "@loopiq/ai/providers/github-copilot";
import { googleProvider } from "@loopiq/ai/providers/google";
import { kimiCodingProvider } from "@loopiq/ai/providers/kimi-coding";
import { minimaxCnProvider } from "@loopiq/ai/providers/minimax-cn";
import { moonshotaiCnProvider } from "@loopiq/ai/providers/moonshotai-cn";
import { openaiProvider } from "@loopiq/ai/providers/openai";
import { openaiCodexProvider } from "@loopiq/ai/providers/openai-codex";
import { openrouterProvider } from "@loopiq/ai/providers/openrouter";
import { zaiCodingCnProvider } from "@loopiq/ai/providers/zai-coding-cn";
import type { CustomProviderConfiguration } from "../configuration/agent-configuration.ts";
import { CUSTOM_OPENAI_PROVIDER_ID, createCustomOpenAIProvider } from "./custom-openai.ts";
import type { ProviderAuthMethod } from "./provider-types.ts";

export interface BuiltinProviderRegistration {
	id: string;
	authMethods: ProviderAuthMethod[];
	create(): Provider;
}

export const BUILTIN_PROVIDER_REGISTRATIONS: readonly BuiltinProviderRegistration[] = [
	{ id: "github-copilot", authMethods: ["oauth", "api_token"], create: githubCopilotProvider },
	{ id: "openai-codex", authMethods: ["oauth"], create: openaiCodexProvider },
	{ id: "openai", authMethods: ["api_token"], create: openaiProvider },
	{ id: "anthropic", authMethods: ["oauth", "api_token"], create: anthropicProvider },
	{ id: "google", authMethods: ["api_token"], create: googleProvider },
	{ id: "openrouter", authMethods: ["api_token"], create: openrouterProvider },
	{ id: "deepseek", authMethods: ["api_token"], create: deepseekProvider },
	{ id: "moonshotai-cn", authMethods: ["api_token"], create: moonshotaiCnProvider },
	{ id: "minimax-cn", authMethods: ["api_token"], create: minimaxCnProvider },
	{ id: "zai-coding-cn", authMethods: ["api_token"], create: zaiCodingCnProvider },
	{ id: "kimi-coding", authMethods: ["api_token"], create: kimiCodingProvider },
];

export function createBuiltinProviderRegistrations(
	customProvider?: CustomProviderConfiguration,
): readonly BuiltinProviderRegistration[] {
	if (!customProvider) return BUILTIN_PROVIDER_REGISTRATIONS;
	return [
		BUILTIN_PROVIDER_REGISTRATIONS[0]!,
		{
			id: CUSTOM_OPENAI_PROVIDER_ID,
			authMethods: ["api_token"],
			create: () => createCustomOpenAIProvider(customProvider),
		},
		...BUILTIN_PROVIDER_REGISTRATIONS.slice(1),
	];
}
