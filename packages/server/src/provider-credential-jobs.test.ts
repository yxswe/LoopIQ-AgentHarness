import type { Agent, ProviderLoginInteraction, ProviderStatus } from "@loopiq/agent";
import { describe, expect, it } from "vitest";
import { type ProviderCredentialJobEvent, ProviderCredentialJobs } from "./provider-credential-jobs.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function agentWithCredentialFlow(flow: (interaction: ProviderLoginInteraction) => Promise<ProviderStatus>): Agent {
	return {
		addProviderCredential: (_providerId, options) => flow(options.interaction),
	} as Agent;
}

describe("ProviderCredentialJobs", () => {
	it("bridges prompts and retains a completed result briefly for replay", async () => {
		const jobs = new ProviderCredentialJobs({ settledRetentionMs: 20 });
		const promptPublished = deferred<Extract<ProviderCredentialJobEvent, { type: "prompt" }>>();
		const settled = deferred<ProviderCredentialJobEvent>();
		const status: ProviderStatus = { providerId: "openai", credentialState: "valid" };
		const agent = agentWithCredentialFlow(async (interaction) => {
			const value = await interaction.prompt({ type: "secret", message: "API token" });
			expect(value).toBe("secret");
			return status;
		});

		const jobId = jobs.start(agent, "openai", "api_token");
		jobs.subscribe(jobId, (event) => {
			if (event.type === "prompt") promptPublished.resolve(event);
			if (event.type === "completed") settled.resolve(event);
		});
		const prompt = await promptPublished.promise;
		expect(jobs.respond(jobId, prompt.promptId, "secret")).toBe(true);
		expect(await settled.promise).toEqual({ type: "completed", status });

		const replayed: ProviderCredentialJobEvent[] = [];
		jobs.subscribe(jobId, (event) => replayed.push(event));
		expect(replayed.at(-1)).toEqual({ type: "completed", status });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(jobs.has(jobId)).toBe(false);
	});

	it("cancels a pending prompt and settles exactly once", async () => {
		const jobs = new ProviderCredentialJobs({ settledRetentionMs: 1_000 });
		const promptPublished = deferred<void>();
		const terminalEvents: ProviderCredentialJobEvent[] = [];
		const canceled = deferred<void>();
		const agent = agentWithCredentialFlow(async (interaction) => {
			await interaction.prompt({ type: "secret", message: "API token" });
			return { providerId: "openai", credentialState: "valid" };
		});

		const jobId = jobs.start(agent, "openai", "api_token");
		jobs.subscribe(jobId, (event) => {
			if (event.type === "prompt") promptPublished.resolve();
			if (event.type === "completed" || event.type === "failed" || event.type === "canceled") {
				terminalEvents.push(event);
				canceled.resolve();
			}
		});
		await promptPublished.promise;
		expect(jobs.cancel(jobId)).toBe(true);
		await canceled.promise;
		expect(terminalEvents).toEqual([{ type: "canceled" }]);
		expect(jobs.cancel(jobId)).toBe(false);
	});
});
