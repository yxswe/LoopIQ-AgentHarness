import { InMemoryCredentialStore } from "@loopiq/ai";
import { describe, expect, it } from "vitest";
import { BUILTIN_PROVIDER_REGISTRATIONS } from "./builtin-providers.ts";
import { ModelRuntime } from "./model-runtime.ts";

describe("ModelRuntime", () => {
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
