import type { ModelReference } from "../base/options.ts";

export type ProviderAuthMethod = "api_token" | "oauth";
export type ProviderCredentialState = "missing" | "unchecked" | "valid" | "invalid" | "unavailable";

export interface ProviderStatus {
	providerId: string;
	credentialState: ProviderCredentialState;
	validatedAt?: string;
	message?: string;
}

export interface ProviderSummary extends ProviderStatus {
	name: string;
	authMethods: ProviderAuthMethod[];
}

export interface ModelSummary extends ModelReference {
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface ListProvidersOptions {
	validateCredentials?: boolean;
}

export interface ListModelsOptions {
	refresh?: boolean;
}

export type ProviderAuthPrompt = { signal?: AbortSignal } & (
	| { type: "text"; message: string; placeholder?: string }
	| { type: "secret"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	| { type: "manual_code"; message: string; placeholder?: string }
);

export type ProviderAuthEvent =
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface ProviderLoginInteraction {
	signal?: AbortSignal;
	prompt(prompt: ProviderAuthPrompt): Promise<string>;
	notify(event: ProviderAuthEvent): void | Promise<void>;
}

export interface AddProviderCredentialOptions {
	method: ProviderAuthMethod;
	interaction: ProviderLoginInteraction;
}
