import { fauxProvider, InMemoryCredentialStore, type Provider } from "@loopiq/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtin-providers.ts";
import { ModelRuntime } from "./model-runtime.ts";

afterEach(() => vi.unstubAllGlobals());

function createCopilotFixture(options?: { availableModelIds?: string[]; refreshError?: Error }) {
	const credentials = new InMemoryCredentialStore();
	const faux = fauxProvider({
		provider: "github-copilot",
		models: [
			{ id: "model-a", name: "Model A" },
			{ id: "model-b", name: "Model B" },
		],
	});
	const availableModelIds = options?.availableModelIds ?? ["model-b", "remote-only"];
	let refreshes = 0;
	const provider: Provider = {
		...faux.provider,
		auth: {
			oauth: {
				name: "GitHub Copilot",
				async login(callbacks) {
					const enterprise = await callbacks.prompt({
						type: "text",
						message: "GitHub Enterprise URL/domain (blank for github.com)",
					});
					if (enterprise !== "") throw new Error("Expected github.com login");
					return {
						type: "oauth",
						access: "candidate-access",
						refresh: "github-access",
						expires: Date.now() + 60_000,
						availableModelIds,
					};
				},
				async refresh(credential) {
					refreshes++;
					if (options?.refreshError) throw options.refreshError;
					return { ...credential, access: `refreshed-${refreshes}`, availableModelIds };
				},
				async toAuth(credential) {
					return { apiKey: credential.access };
				},
			},
		},
	};
	return {
		credentials,
		registration: {
			id: "github-copilot",
			authMethods: ["oauth"] as const,
			create: () => provider,
		},
		getRefreshes: () => refreshes,
	};
}

describe("ModelRuntime", () => {
	it("uses github.com directly and validates a first Copilot login with an account-available local model", async () => {
		const fixture = createCopilotFixture();
		let validatedModelId: string | undefined;
		const prompts: string[] = [];
		const runtime = new ModelRuntime({
			credentials: fixture.credentials,
			registrations: [fixture.registration],
			validator: async (_registration, credential, _signal, modelId) => {
				validatedModelId = modelId;
				return { state: "valid" as const, credential };
			},
		});

		const status = await runtime.addProviderCredential("github-copilot", {
			method: "oauth",
			interaction: {
				async prompt(prompt) {
					prompts.push(prompt.type);
					if (prompt.type !== "select") throw new Error("Unexpected prompt");
					expect(prompt.options.map((option) => option.id)).toEqual(["model-b"]);
					return "model-b";
				},
				notify: () => {},
			},
		});

		expect(status.credentialState).toBe("valid");
		expect(prompts).toEqual(["select"]);
		expect(validatedModelId).toBe("model-b");
		expect(await fixture.credentials.read("github-copilot")).toMatchObject({ access: "candidate-access" });
	});

	it("rejects an unavailable Copilot model selection without persisting the candidate", async () => {
		const fixture = createCopilotFixture();
		const runtime = new ModelRuntime({
			credentials: fixture.credentials,
			registrations: [fixture.registration],
			validator: async (_registration, credential) => ({ state: "valid" as const, credential }),
		});

		await expect(
			runtime.addProviderCredential("github-copilot", {
				method: "oauth",
				interaction: { prompt: async () => "model-a", notify: () => {} },
			}),
		).rejects.toMatchObject({ code: "provider_credential_setup_failed" });
		expect(await fixture.credentials.read("github-copilot")).toBeUndefined();
	});

	it("rejects a Copilot login with no account-available local models", async () => {
		const fixture = createCopilotFixture({ availableModelIds: ["remote-only"] });
		const runtime = new ModelRuntime({
			credentials: fixture.credentials,
			registrations: [fixture.registration],
			validator: async (_registration, credential) => ({ state: "valid" as const, credential }),
		});

		await expect(
			runtime.addProviderCredential("github-copilot", {
				method: "oauth",
				interaction: { prompt: async () => "model-a", notify: () => {} },
			}),
		).rejects.toMatchObject({ code: "provider_credential_setup_failed" });
		expect(await fixture.credentials.read("github-copilot")).toBeUndefined();
	});

	it("does not repeat Copilot model selection when replacing a credential", async () => {
		const fixture = createCopilotFixture();
		await fixture.credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 60_000,
			availableModelIds: ["model-a"],
		}));
		let validatedModelId: string | undefined;
		const runtime = new ModelRuntime({
			credentials: fixture.credentials,
			registrations: [fixture.registration],
			validator: async (_registration, credential, _signal, modelId) => {
				validatedModelId = modelId;
				return { state: "valid" as const, credential };
			},
		});

		await runtime.addProviderCredential("github-copilot", {
			method: "oauth",
			interaction: { prompt: async () => Promise.reject(new Error("Unexpected visible prompt")), notify: () => {} },
		});

		expect(validatedModelId).toBe("model-b");
		expect(await fixture.credentials.read("github-copilot")).toMatchObject({ access: "candidate-access" });
	});

	it("refreshes Copilot models on every listing and intersects account availability with the local catalog", async () => {
		const fixture = createCopilotFixture();
		await fixture.credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "github-access",
			expires: Date.now() - 1,
			availableModelIds: ["model-a"],
		}));
		const runtime = new ModelRuntime({ credentials: fixture.credentials, registrations: [fixture.registration] });

		expect((await runtime.listModels()).map((model) => model.modelId)).toEqual(["model-b"]);
		expect((await runtime.listModels("github-copilot")).map((model) => model.modelId)).toEqual(["model-b"]);
		expect((await runtime.listModels("github-copilot", { refresh: true })).map((model) => model.modelId)).toEqual([
			"model-b",
		]);
		expect(fixture.getRefreshes()).toBe(3);
		expect(await fixture.credentials.read("github-copilot")).toMatchObject({
			access: "refreshed-3",
			availableModelIds: ["model-b", "remote-only"],
		});
	});

	it("lists only credential-backed providers when no provider is specified", async () => {
		const credentials = new InMemoryCredentialStore();
		const configured = fauxProvider({ provider: "configured-provider" });
		const missing = fauxProvider({ provider: "missing-provider" });
		await credentials.modify("configured-provider", async () => ({ type: "api_key", key: "configured" }));
		const runtime = new ModelRuntime({
			credentials,
			registrations: [
				{ id: "configured-provider", authMethods: ["api_token"], create: () => configured.provider },
				{ id: "missing-provider", authMethods: ["api_token"], create: () => missing.provider },
			],
		});

		expect((await runtime.listModels()).map((model) => model.providerId)).toEqual(["configured-provider"]);
		expect((await runtime.listModels("missing-provider")).map((model) => model.providerId)).toEqual([
			"missing-provider",
		]);
	});

	it("reports Copilot model discovery failures without falling back to the static catalog", async () => {
		const fixture = createCopilotFixture({ refreshError: new Error("catalog unavailable") });
		await fixture.credentials.modify("github-copilot", async () => ({
			type: "oauth",
			access: "old-access",
			refresh: "github-access",
			expires: Date.now() + 60_000,
			availableModelIds: ["model-a"],
		}));
		const runtime = new ModelRuntime({ credentials: fixture.credentials, registrations: [fixture.registration] });

		await expect(runtime.listModels("github-copilot")).rejects.toMatchObject({
			code: "provider_validation_unavailable",
		});
	});

	it("lists only models currently advertised by the local LiteLLM Copilot proxy", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("litellm-copilot", async () => ({ type: "api_key", key: "secret" }));
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ data: [{ id: "gpt-5.3-codex" }, { id: "gpt-5.6-sol" }] }), {
						status: 200,
					}),
			),
		);
		const registration = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "litellm-copilot")!;
		const runtime = new ModelRuntime({ credentials, registrations: [registration] });

		expect((await runtime.listModels("litellm-copilot")).map((model) => model.modelId)).toEqual(["gpt-5.3-codex"]);
	});

	it("validates before persisting and removes only the credential", async () => {
		const credentials = new InMemoryCredentialStore();
		const openai = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "openai")!;
		const runtime = new ModelRuntime({
			credentials,
			registrations: [openai],
			validator: async (_registration, credential) => ({ state: "valid" as const, credential }),
		});

		const status = await runtime.addProviderCredential("openai", {
			method: "api_token",
			interaction: { prompt: async () => "secret", notify: () => {} },
		});
		expect(status.credentialState).toBe("valid");
		expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "secret" });
		expect((await runtime.listProviders())[0]).toMatchObject({ providerId: "openai", credentialState: "valid" });

		await runtime.removeProviderCredential("openai");
		expect(await credentials.read("openai")).toBeUndefined();
		expect((await runtime.listProviders())[0]).toMatchObject({ providerId: "openai", credentialState: "missing" });
	});

	it("does not replace an existing credential when validation fails", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "working" }));
		const openai = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "openai")!;
		const runtime = new ModelRuntime({
			credentials,
			registrations: [openai],
			validator: async (_registration, credential) => ({
				state: "invalid" as const,
				credential,
				message: "rejected",
			}),
		});

		await expect(
			runtime.addProviderCredential("openai", {
				method: "api_token",
				interaction: { prompt: async () => "bad", notify: () => {} },
			}),
		).rejects.toMatchObject({ code: "provider_credential_invalid" });
		expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "working" });
	});

	it("does not persist a credential when setup is canceled during validation", async () => {
		const credentials = new InMemoryCredentialStore();
		const openai = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "openai")!;
		let finishValidation!: () => void;
		let validationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			validationStarted = resolve;
		});
		const finish = new Promise<void>((resolve) => {
			finishValidation = resolve;
		});
		const runtime = new ModelRuntime({
			credentials,
			registrations: [openai],
			validator: async (_registration, credential) => {
				validationStarted();
				await finish;
				return { state: "valid" as const, credential };
			},
		});
		const controller = new AbortController();

		const setup = runtime.addProviderCredential("openai", {
			method: "api_token",
			interaction: { signal: controller.signal, prompt: async () => "secret", notify: () => {} },
		});
		await started;
		controller.abort();
		finishValidation();

		await expect(setup).rejects.toMatchObject({ code: "provider_credential_canceled" });
		expect(await credentials.read("openai")).toBeUndefined();
	});

	it("invalidates cached status when another store user replaces the credential", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "first" }));
		const openai = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "openai")!;
		let validations = 0;
		const runtime = new ModelRuntime({
			credentials,
			registrations: [openai],
			validator: async (_registration, credential) => {
				validations++;
				return { state: "valid" as const, credential };
			},
		});

		expect((await runtime.validateProviderCredential("openai")).credentialState).toBe("valid");
		expect((await runtime.getProviderStatus("openai")).credentialState).toBe("valid");
		await credentials.modify("openai", async () => ({ type: "api_key", key: "second" }));
		expect((await runtime.getProviderStatus("openai")).credentialState).toBe("unchecked");
		expect((await runtime.validateProviderCredential("openai")).credentialState).toBe("valid");
		expect(validations).toBe(2);
	});

	it("revalidates the current credential when it changes during validation", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("openai", async () => ({ type: "api_key", key: "first" }));
		const openai = BUILTIN_PROVIDER_REGISTRATIONS.find((provider) => provider.id === "openai")!;
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const validatedKeys: string[] = [];
		const runtime = new ModelRuntime({
			credentials,
			registrations: [openai],
			validator: async (_registration, credential) => {
				const key = credential.type === "api_key" ? credential.key! : "oauth";
				validatedKeys.push(key);
				if (key === "first") {
					firstStarted();
					await release;
				}
				return { state: "valid" as const, credential };
			},
		});

		const validation = runtime.validateProviderCredential("openai");
		await started;
		await credentials.modify("openai", async () => ({ type: "api_key", key: "second" }));
		releaseFirst();

		expect((await validation).credentialState).toBe("valid");
		expect(validatedKeys).toEqual(["first", "second"]);
		expect((await runtime.getProviderStatus("openai")).credentialState).toBe("valid");
	});
});
