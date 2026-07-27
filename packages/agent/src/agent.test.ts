import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Credential,
	type CredentialStore,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type Provider,
} from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Agent } from "./agent.ts";
import { DEFAULT_PROVIDER_REQUEST_POLICY } from "./base/options.ts";
import { createAgent, createAgentForTesting } from "./create-agent.ts";
import { ModelRuntime } from "./model/model-runtime.ts";

const agents: Agent[] = [];
const dataDirs: string[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class ControllableCredentialStore implements CredentialStore {
	private readonly store = new InMemoryCredentialStore();
	private nextRead: { started: ReturnType<typeof deferred>; released: ReturnType<typeof deferred> } | undefined;

	blockNextRead() {
		const block = { started: deferred(), released: deferred() };
		this.nextRead = block;
		return { started: block.started.promise, release: block.released.resolve };
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const block = this.nextRead;
		if (block) {
			this.nextRead = undefined;
			block.started.resolve();
			await block.released.promise;
		}
		return this.store.read(providerId);
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn);
	}

	delete(providerId: string): Promise<void> {
		return this.store.delete(providerId);
	}
}

afterEach(async () => {
	await Promise.all(agents.splice(0).map((agent) => agent.shutdown({ abortRunning: true })));
	await Promise.all(dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })));
});

async function createFixture(credentials: CredentialStore = new InMemoryCredentialStore()) {
	const dataDir = await mkdtemp(join(tmpdir(), "loopiq-agent-"));
	dataDirs.push(dataDir);
	const faux = fauxProvider({ provider: `agent-faux-${Math.random()}` });
	const provider: Provider = {
		...faux.provider,
		auth: {
			apiKey: {
				name: "Faux",
				resolve: async ({ credential }) => {
					if (credential?.type !== "api_key") throw new Error("Faux credential is missing");
					return { auth: { apiKey: credential.key }, source: "stored credential" };
				},
			},
		},
	};
	const model = faux.getModel();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test" }));
	const modelRuntime = new ModelRuntime({
		credentials,
		registrations: [{ id: model.provider, authMethods: ["api_token"], create: () => provider }],
		validator: async (_registration, credential) => ({ state: "valid" as const, credential }),
	});
	const agent = await createAgentForTesting({
		dataDir,
		modelRuntime,
		defaultModel: { providerId: model.provider, modelId: model.id },
	});
	agents.push(agent);
	return { agent, faux, model };
}

describe("Agent", () => {
	it("initializes the supported providers and persists the application default", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "loopiq-agent-default-"));
		dataDirs.push(dataDir);
		const first = await createAgent({ dataDir });
		agents.push(first);
		expect((await first.listProviders()).map((provider) => provider.providerId)).toEqual([
			"github-copilot",
			"openai-codex",
			"openai",
			"anthropic",
			"google",
			"openrouter",
			"deepseek",
			"moonshotai-cn",
			"minimax-cn",
			"zai-coding-cn",
			"kimi-coding",
		]);
		expect(await first.getConfiguration()).toEqual({
			defaultModel: { providerId: "github-copilot", modelId: "claude-opus-4.6" },
			defaultThinkingLevel: "high",
			providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
		});
		await first.updateConfiguration({
			defaultModel: { providerId: "openai", modelId: "gpt-4.1-mini" },
			defaultThinkingLevel: "medium",
			providerRequest: { transport: "sse", timeoutMs: 120_000 },
		});
		await first.shutdown();
		agents.splice(agents.indexOf(first), 1);

		const reopened = await createAgent({ dataDir });
		agents.push(reopened);
		expect(await reopened.getConfiguration()).toEqual({
			defaultModel: { providerId: "openai", modelId: "gpt-4.1-mini" },
			defaultThinkingLevel: "medium",
			providerRequest: { ...DEFAULT_PROVIDER_REQUEST_POLICY, transport: "sse", timeoutMs: 120_000 },
		});
	});

	it("applies the current Agent request policy to the next provider request", async () => {
		const { agent, faux } = await createFixture();
		const session = await agent.createSession({ cwd: process.cwd() });
		expect(session.thinkingLevel).toBe("high");
		const observedOptions: Array<Record<string, unknown>> = [];
		faux.setResponses([
			(_context, options) => {
				observedOptions.push(options as Record<string, unknown>);
				return fauxAssistantMessage("first");
			},
			(_context, options) => {
				observedOptions.push(options as Record<string, unknown>);
				return fauxAssistantMessage("second");
			},
		]);
		expect((await (await agent.run(session.id, { text: "before update" })).result).status).toBe("completed");
		await agent.updateConfiguration({
			providerRequest: {
				transport: "sse",
				timeoutMs: 123_000,
				maxRetries: 2,
				maxRetryDelayMs: 4_000,
				cacheRetention: "none",
			},
		});
		expect((await (await agent.run(session.id, { text: "after update" })).result).status).toBe("completed");
		expect(observedOptions[0]).toMatchObject(DEFAULT_PROVIDER_REQUEST_POLICY);
		expect(observedOptions[1]).toMatchObject({
			transport: "sse",
			timeoutMs: 123_000,
			maxRetries: 2,
			maxRetryDelayMs: 4_000,
			cacheRetention: "none",
		});
	});

	it("rejects invalid or sensitive persisted request-policy fields", async () => {
		const { agent } = await createFixture();
		await expect(agent.updateConfiguration({ providerRequest: { timeoutMs: 0 } })).rejects.toMatchObject({
			code: "invalid_argument",
		});
		await expect(
			agent.updateConfiguration({ providerRequest: { headers: { Authorization: "secret" } } } as never),
		).rejects.toMatchObject({ code: "invalid_argument" });
		await expect(agent.updateConfiguration({ defaultThinkingLevel: "invalid" as never })).rejects.toMatchObject({
			code: "invalid_argument",
		});
	});

	it("owns Session lifecycle and runs through identity-based methods", async () => {
		const { agent, faux } = await createFixture();
		const session = await agent.createSession({ cwd: process.cwd() });
		const eventTypes: string[] = [];
		const unsubscribe = await agent.subscribe(session.id, (envelope) => eventTypes.push(envelope.event.type));
		faux.setResponses([fauxAssistantMessage("done")]);

		const handle = await agent.run(session.id, { text: "hello" });
		const result = await handle.result;

		expect(result.status).toBe("completed");
		expect(result.sessionId).toBe(session.id);
		expect(eventTypes.at(-1)).toBe("run_settled");
		expect((await agent.getSession(session.id)).state).toBe("idle");
		expect((await agent.listSessions()).map((entry) => entry.id)).toContain(session.id);
		unsubscribe();
	});

	it("updates configuration and rejects stale run commands at the Agent boundary", async () => {
		const { agent, faux, model } = await createFixture();
		const session = await agent.createSession({ cwd: process.cwd() });
		const updated = await agent.updateSession(session.id, {
			model: { providerId: model.provider, modelId: model.id },
			thinkingLevel: "high",
		});
		expect(updated.thinkingLevel).toBe("high");
		faux.setResponses([fauxAssistantMessage("done")]);
		const handle = await agent.run(session.id, { text: "hello" });
		await handle.result;

		await expect(agent.abort(session.id, handle.runId)).rejects.toThrow(/stale|mismatched/i);
	});

	it("allows credential removal while the provider has an active run", async () => {
		const { agent, faux } = await createFixture();
		const session = await agent.createSession({ cwd: process.cwd() });
		const request = { started: deferred(), released: deferred() };
		faux.setResponses([
			async () => {
				request.started.resolve();
				await request.released.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const handle = await agent.run(session.id, { text: "hello" });
		await request.started.promise;
		await agent.removeProviderCredential(session.model.providerId);
		request.released.resolve();

		expect((await handle.result).status).toBe("completed");
		expect(await agent.getProviderStatus(session.model.providerId)).toMatchObject({ credentialState: "missing" });

		const failedHandle = await agent.run(session.id, { text: "again" });
		expect((await failedHandle.result).status).toBe("failed");
	});

	it("returns a run handle before request-time credential resolution completes", async () => {
		const credentials = new ControllableCredentialStore();
		const { agent, faux } = await createFixture(credentials);
		const session = await agent.createSession({ cwd: process.cwd() });
		faux.setResponses([fauxAssistantMessage("done")]);
		const read = credentials.blockNextRead();

		const handle = await agent.run(session.id, { text: "hello" });
		expect(handle.runId).toBeTruthy();
		await read.started;
		read.release();

		expect((await handle.result).status).toBe("completed");
	});
});
