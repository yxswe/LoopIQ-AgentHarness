import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Credential,
	type CredentialStore,
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
} from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, createAgent, createAgentForTesting } from "./agent.ts";
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
	const model = faux.getModel();
	await credentials.modify(model.provider, async () => ({ type: "api_key", key: "test" }));
	const modelRuntime = new ModelRuntime({
		credentials,
		registrations: [{ id: model.provider, authMethods: ["api_token"], create: () => faux.provider }],
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
		});
		await first.updateConfiguration({
			defaultModel: { providerId: "openai", modelId: "gpt-4.1-mini" },
		});
		await first.shutdown();
		agents.splice(agents.indexOf(first), 1);

		const reopened = await createAgent({ dataDir });
		agents.push(reopened);
		expect(await reopened.getConfiguration()).toEqual({
			defaultModel: { providerId: "openai", modelId: "gpt-4.1-mini" },
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

	it("rejects credential removal while the provider has an active run", async () => {
		const { agent, faux } = await createFixture();
		const session = await agent.createSession({ cwd: process.cwd() });
		faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("done");
			},
		]);
		const handle = await agent.run(session.id, { text: "hello" });
		await expect(agent.removeProviderCredential(session.model.providerId)).rejects.toMatchObject({
			code: "provider_busy",
		});
		await agent.abort(session.id, handle.runId);
		await agent.removeProviderCredential(session.model.providerId);
		await expect(agent.run(session.id, { text: "again" })).rejects.toMatchObject({
			code: "provider_auth_required",
		});
	});

	it("reserves provider use during authentication preflight", async () => {
		const credentials = new ControllableCredentialStore();
		const { agent, faux } = await createFixture(credentials);
		const session = await agent.createSession({ cwd: process.cwd() });
		faux.setResponses([fauxAssistantMessage("done")]);
		const read = credentials.blockNextRead();

		const pendingRun = agent.run(session.id, { text: "hello" });
		await read.started;
		await expect(agent.removeProviderCredential(session.model.providerId)).rejects.toMatchObject({
			code: "provider_busy",
		});
		read.release();

		expect((await (await pendingRun).result).status).toBe("completed");
	});
});
