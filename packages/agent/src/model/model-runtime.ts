import {
	type Credential,
	type CredentialStore,
	createModels,
	InMemoryCredentialStore,
	type Model,
	type Models,
	type MutableModels,
} from "@loopiq/ai";
import type { ModelReference } from "../base/options.ts";
import { AgentRuntimeError, toError } from "../base/types.ts";
import type { BuiltinProviderRegistration } from "./builtin-providers.ts";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtin-providers.ts";
import type {
	AddProviderCredentialOptions,
	ListModelsOptions,
	ListProvidersOptions,
	ModelSummary,
	ProviderAuthEvent,
	ProviderAuthPrompt,
	ProviderCredentialState,
	ProviderStatus,
	ProviderSummary,
} from "./provider-types.ts";

const VALIDATION_TTL_MS = 5 * 60_000;
const AUTH_REJECTION = /(?:401|403|unauthori[sz]ed|forbidden|invalid[^\n]*(?:key|token|credential)|authentication)/i;

interface CachedValidation {
	status: ProviderStatus;
	expiresAt: number;
	credentialKey: string;
}

interface ValidationResult {
	state: Extract<ProviderCredentialState, "valid" | "invalid" | "unavailable">;
	credential: Credential;
	message?: string;
}

export type CredentialValidator = (
	registration: BuiltinProviderRegistration,
	credential: Credential,
	signal?: AbortSignal,
) => Promise<ValidationResult>;

export class ModelRuntime {
	/**
	 * Narrow capability view shared with the Session host and Agent engine. `Models`
	 * supports provider/model lookup, catalog refresh, auth resolution, and model
	 * execution, but it does not expose provider-registry mutation methods.
	 */
	readonly models: Models;
	/**
	 * The same collection instance as `models`, retained under its wider internal
	 * type. `MutableModels` extends `Models` with `setProvider()`, `deleteProvider()`,
	 * and `clearProviders()` so only ModelRuntime can change the provider registry.
	 * Assigning `this.models = this.mutableModels` creates no copy or wrapper; the
	 * two fields are different type views of one object.
	 */
	private readonly mutableModels: MutableModels;
	private readonly credentials: CredentialStore;
	private readonly credentialMutations = new Set<string>();
	private readonly registrations: Map<string, BuiltinProviderRegistration>;
	private readonly validationCache = new Map<string, CachedValidation>();
	private readonly validateCredential: CredentialValidator;

	constructor(options: {
		credentials: CredentialStore;
		registrations?: readonly BuiltinProviderRegistration[];
		validator?: CredentialValidator;
	}) {
		this.credentials = options.credentials;
		const registrations = options.registrations ?? BUILTIN_PROVIDER_REGISTRATIONS;
		this.registrations = new Map(registrations.map((registration) => [registration.id, registration]));
		this.mutableModels = createModels({ credentials: this.credentials });
		for (const registration of registrations) this.mutableModels.setProvider(registration.create());
		this.models = this.mutableModels;
		this.validateCredential =
			options.validator ??
			((registration, credential, signal) => this.validateWithProvider(registration, credential, signal));
	}

	async resolveModel(reference: ModelReference, refresh = true): Promise<Model<any>> {
		this.requireRegistration(reference.providerId);
		let model = this.mutableModels.getModel(reference.providerId, reference.modelId);
		if (!model && refresh) {
			await this.mutableModels.refresh(reference.providerId);
			model = this.mutableModels.getModel(reference.providerId, reference.modelId);
		}
		if (!model) {
			throw new AgentRuntimeError("model_not_found", `Unknown model ${reference.providerId}/${reference.modelId}`);
		}
		return model;
	}

	async resolveSwitchableModel(reference: ModelReference): Promise<Model<any>> {
		const status = await this.validateProviderCredential(reference.providerId);
		this.requireValidProvider(status);
		return this.resolveModel(reference);
	}

	async listModels(providerId?: string, options?: ListModelsOptions): Promise<ModelSummary[]> {
		if (providerId) this.requireRegistration(providerId);
		if (options?.refresh) await this.mutableModels.refresh(providerId);
		return this.mutableModels.getModels(providerId).map((model) => ({
			providerId: model.provider,
			modelId: model.id,
			name: model.name,
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
	}

	async listProviders(options?: ListProvidersOptions): Promise<ProviderSummary[]> {
		return Promise.all(
			[...this.registrations.values()].map(async (registration) => {
				const provider = this.mutableModels.getProvider(registration.id)!;
				const status = options?.validateCredentials
					? await this.validateProviderCredential(registration.id)
					: await this.getLocalProviderStatus(registration.id);
				return { ...status, name: provider.name, authMethods: [...registration.authMethods] };
			}),
		);
	}

	async getProviderStatus(providerId: string): Promise<ProviderStatus> {
		this.requireRegistration(providerId);
		const credential = await this.credentials.read(providerId);
		if (!credential) return { providerId, credentialState: "missing" };
		const cached = this.validationCache.get(providerId);
		if (cached && cached.expiresAt > Date.now() && cached.credentialKey === this.credentialKey(credential)) {
			return { ...cached.status };
		}
		return { providerId, credentialState: "unchecked" };
	}

	async addProviderCredential(providerId: string, options: AddProviderCredentialOptions): Promise<ProviderStatus> {
		return this.withCredentialMutation(providerId, () => this.addProviderCredentialUnlocked(providerId, options));
	}

	private async addProviderCredentialUnlocked(
		providerId: string,
		options: AddProviderCredentialOptions,
	): Promise<ProviderStatus> {
		const registration = this.requireRegistration(providerId);
		if (!registration.authMethods.includes(options.method)) {
			throw new AgentRuntimeError(
				"invalid_argument",
				`Provider ${providerId} does not support ${options.method} credentials`,
			);
		}

		const provider = registration.create();
		let candidate: Credential;
		try {
			if (options.method === "oauth") {
				if (!provider.auth.oauth) throw new Error(`Provider ${providerId} has no OAuth implementation`);
				candidate = await provider.auth.oauth.login(this.toAuthCallbacks(options.interaction));
			} else {
				if (!provider.auth.apiKey?.login) throw new Error(`Provider ${providerId} has no API-token login`);
				candidate = await provider.auth.apiKey.login(this.toAuthCallbacks(options.interaction));
			}
		} catch (error) {
			if (options.interaction.signal?.aborted) {
				throw new AgentRuntimeError("provider_credential_canceled", `Credential setup canceled for ${providerId}`);
			}
			throw new AgentRuntimeError(
				"provider_credential_setup_failed",
				`Credential setup failed for ${providerId}`,
				toError(error),
			);
		}

		if (options.interaction.signal?.aborted) {
			throw new AgentRuntimeError("provider_credential_canceled", `Credential setup canceled for ${providerId}`);
		}
		const validation = await this.validateCredential(registration, candidate, options.interaction.signal);
		if (options.interaction.signal?.aborted) {
			throw new AgentRuntimeError("provider_credential_canceled", `Credential setup canceled for ${providerId}`);
		}
		if (validation.state !== "valid") throw this.validationError(providerId, validation);
		await this.credentials.modify(providerId, async () => validation.credential);
		return this.cacheValidation(providerId, validation);
	}

	async validateProviderCredential(providerId: string, force = false): Promise<ProviderStatus> {
		const registration = this.requireRegistration(providerId);
		let credential = await this.credentials.read(providerId);
		if (!credential) return { providerId, credentialState: "missing" };
		const cached = this.validationCache.get(providerId);
		if (
			!force &&
			cached &&
			cached.expiresAt > Date.now() &&
			cached.credentialKey === this.credentialKey(credential)
		) {
			return { ...cached.status };
		}

		while (true) {
			const validation = await this.validateCredential(registration, credential);
			const validatedCredential = validation.state === "valid" ? validation.credential : credential;
			const persisted = await this.credentials.modify(providerId, async (current) => {
				if (this.credentialKey(current) !== this.credentialKey(credential)) return undefined;
				return this.credentialKey(validatedCredential) === this.credentialKey(credential)
					? undefined
					: validatedCredential;
			});
			if (!persisted) {
				this.validationCache.delete(providerId);
				return { providerId, credentialState: "missing" };
			}
			if (this.credentialKey(persisted) !== this.credentialKey(validatedCredential)) {
				credential = persisted;
				continue;
			}
			return this.cacheValidation(providerId, { ...validation, credential: persisted });
		}
	}

	async removeProviderCredential(providerId: string): Promise<void> {
		await this.withCredentialMutation(providerId, async () => {
			this.requireRegistration(providerId);
			await this.credentials.delete(providerId);
			this.validationCache.delete(providerId);
		});
	}

	private async withCredentialMutation<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
		if (this.credentialMutations.has(providerId)) {
			throw new AgentRuntimeError(
				"provider_busy",
				`Provider ${providerId} already has a credential mutation in progress`,
			);
		}
		this.credentialMutations.add(providerId);
		try {
			return await operation();
		} finally {
			this.credentialMutations.delete(providerId);
		}
	}

	private requireValidProvider(status: ProviderStatus): void {
		if (status.credentialState === "valid") return;
		if (status.credentialState === "missing" || status.credentialState === "unchecked") {
			throw new AgentRuntimeError(
				"provider_auth_required",
				`Provider ${status.providerId} requires a valid credential`,
			);
		}
		if (status.credentialState === "invalid") {
			throw new AgentRuntimeError(
				"provider_credential_invalid",
				status.message ?? `Provider ${status.providerId} rejected its credential`,
			);
		}
		throw new AgentRuntimeError(
			"provider_validation_unavailable",
			status.message ?? `Could not validate provider ${status.providerId}`,
		);
	}

	private requireRegistration(providerId: string): BuiltinProviderRegistration {
		const registration = this.registrations.get(providerId);
		if (!registration) throw new AgentRuntimeError("provider_not_found", `Unsupported provider ${providerId}`);
		return registration;
	}

	private async getLocalProviderStatus(providerId: string): Promise<ProviderStatus> {
		const credential = await this.credentials.read(providerId);
		if (!credential) return { providerId, credentialState: "missing" };
		const cached = this.validationCache.get(providerId);
		if (cached && cached.expiresAt > Date.now() && cached.credentialKey === this.credentialKey(credential)) {
			return { ...cached.status };
		}
		return { providerId, credentialState: "unchecked" };
	}

	private credentialKey(credential: Credential | undefined): string | undefined {
		return credential === undefined ? undefined : JSON.stringify(credential);
	}

	private cacheValidation(providerId: string, validation: ValidationResult): ProviderStatus {
		const status: ProviderStatus = {
			providerId,
			credentialState: validation.state,
			validatedAt: new Date().toISOString(),
			message: validation.message,
		};
		this.validationCache.set(providerId, {
			status,
			expiresAt: Date.now() + VALIDATION_TTL_MS,
			credentialKey: this.credentialKey(validation.credential)!,
		});
		return { ...status };
	}

	private toAuthCallbacks(interaction: AddProviderCredentialOptions["interaction"]) {
		return {
			signal: interaction.signal,
			prompt: (prompt: ProviderAuthPrompt) => interaction.prompt(prompt),
			notify: (event: ProviderAuthEvent) => {
				void interaction.notify(event);
			},
		};
	}

	private async validateWithProvider(
		registration: BuiltinProviderRegistration,
		credential: Credential,
		signal?: AbortSignal,
	): Promise<ValidationResult> {
		const temporaryCredentials = new InMemoryCredentialStore();
		await temporaryCredentials.modify(registration.id, async () => credential);
		const models = createModels({ credentials: temporaryCredentials });
		models.setProvider(registration.create());
		const model = models.getModels(registration.id)[0];
		if (!model) return { state: "unavailable", credential, message: "Provider has no validation model" };

		try {
			const response = await models.completeSimple(
				model,
				{
					systemPrompt: "This is an authentication validation request. Reply with OK.",
					messages: [{ role: "user", content: "OK", timestamp: Date.now() }],
				},
				{ maxTokens: 1, maxRetries: 0, timeoutMs: 10_000, signal },
			);
			const finalCredential = (await temporaryCredentials.read(registration.id)) ?? credential;
			if (response.stopReason !== "error" && response.stopReason !== "aborted") {
				return { state: "valid", credential: finalCredential };
			}
			const message = response.errorMessage ?? "Provider rejected credential validation";
			return {
				state: AUTH_REJECTION.test(message) ? "invalid" : "unavailable",
				credential: finalCredential,
				message,
			};
		} catch (error) {
			const message = toError(error).message;
			return { state: AUTH_REJECTION.test(message) ? "invalid" : "unavailable", credential, message };
		}
	}

	private validationError(providerId: string, validation: ValidationResult): AgentRuntimeError {
		return validation.state === "invalid"
			? new AgentRuntimeError(
					"provider_credential_invalid",
					validation.message ?? `Provider ${providerId} rejected the credential`,
				)
			: new AgentRuntimeError(
					"provider_validation_unavailable",
					validation.message ?? `Could not validate provider ${providerId}`,
				);
	}
}
