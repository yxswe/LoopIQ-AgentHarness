import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@loopiq/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROVIDER_REQUEST_POLICY } from "../base/options.ts";
import { AgentEngine } from "../engine/agent-engine.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { AgentSession } from "./agent-session.ts";
import { JsonlSessionStore } from "./storage/jsonl-session-store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createRuntimeWithStore(name: string, dependencies: ReturnType<typeof createDependencies>) {
	const directory = await mkdtemp(join(tmpdir(), `loopiq-${name}-`));
	temporaryDirectories.push(directory);
	const env = new NodeExecutionEnv({ cwd: directory });
	const store = await JsonlSessionStore.create(env, join(directory, "session.jsonl"), {
		workspaceDir: directory,
		sessionId: name,
	});
	const session = await AgentSession.load({
		env,
		store,
		engine: dependencies.engine,
		defaults: {
			model: { providerId: dependencies.model.provider, modelId: dependencies.model.id },
			thinkingLevel: "high",
		},
	});
	return { session, store };
}

async function createRuntime(name: string, dependencies: ReturnType<typeof createDependencies>): Promise<AgentSession> {
	return (await createRuntimeWithStore(name, dependencies)).session;
}

function createDependencies(options?: { tokensPerSecond?: number; tokenSize?: number }) {
	const faux = fauxProvider({
		provider: `faux-${Math.random()}`,
		tokensPerSecond: options?.tokensPerSecond,
		tokenSize: options?.tokenSize ? { min: options.tokenSize, max: options.tokenSize } : undefined,
	});
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		model: faux.getModel(),
		engine: new AgentEngine({
			models,
			getProviderRequestPolicy: () => DEFAULT_PROVIDER_REQUEST_POLICY,
		}),
	};
}

function assistantText(message: { content: Array<{ type: string; text?: string }> } | undefined): string {
	return message?.content.map((content) => (content.type === "text" ? content.text : "")).join("") ?? "";
}

describe("AgentSession", () => {
	it("uses Session-owned default tools and the Engine-owned static System Prompt", async () => {
		const faux = fauxProvider({ provider: `faux-${Math.random()}` });
		const models = createModels();
		models.setProvider(faux.provider);
		const observedToolSets: Array<Array<{ name: string }>> = [];
		const engine = new AgentEngine({
			models,
			getProviderRequestPolicy: () => DEFAULT_PROVIDER_REQUEST_POLICY,
		});
		const dependencies = { faux, model: faux.getModel(), engine };
		const respond = (context: { systemPrompt?: string; tools?: Array<{ name: string }> }) => {
			if (context.tools) {
				observedToolSets.push(context.tools);
			}
			return fauxAssistantMessage(context.systemPrompt ?? "");
		};
		faux.setResponses([respond, respond]);
		const sessionA = await createRuntime("engine-assets-a", dependencies);
		const sessionB = await createRuntime("engine-assets-b", dependencies);

		const [resultA, resultB] = await Promise.all([
			sessionA.startRun({ text: "alpha" }).result,
			sessionB.startRun({ text: "beta" }).result,
		]);

		expect(new Set(observedToolSets.map((tools) => tools[0])).size).toBe(2);
		for (const result of [resultA, resultB]) {
			const text = assistantText(result.finalMessage);
			expect(text).toBe("You are a helpful coding agent running inside LoopIQ Agent.");
		}
	});

	it("restores context once and maintains later turns incrementally in memory", async () => {
		const dependencies = createDependencies();
		dependencies.faux.setResponses([
			fauxAssistantMessage("first-answer"),
			(context) => fauxAssistantMessage(JSON.stringify(context.messages)),
		]);
		const directory = await mkdtemp(join(tmpdir(), "loopiq-incremental-context-"));
		temporaryDirectories.push(directory);
		const env = new NodeExecutionEnv({ cwd: directory });
		const store = await JsonlSessionStore.create(env, join(directory, "session.jsonl"), {
			workspaceDir: directory,
			sessionId: "incremental-context",
		});
		const restore = vi.spyOn(store, "restore");
		const session = await AgentSession.load({
			env,
			store,
			engine: dependencies.engine,
			defaults: {
				model: { providerId: dependencies.model.provider, modelId: dependencies.model.id },
				thinkingLevel: "high",
			},
		});

		await session.startRun({ text: "first-question" }).result;
		const second = await session.startRun({ text: "second-question" }).result;

		expect(restore).toHaveBeenCalledTimes(1);
		expect(assistantText(second.finalMessage)).toContain("first-answer");
		expect(assistantText(second.finalMessage)).toContain("second-question");
	});

	it("runs two Sessions concurrently through one stateless engine without context bleed", async () => {
		const dependencies = createDependencies();
		const respond = (context: { systemPrompt?: string; messages: Array<{ role: string; content?: unknown }> }) =>
			fauxAssistantMessage(`${context.systemPrompt}:${JSON.stringify(context.messages.at(-1))}`);
		dependencies.faux.setResponses([respond, respond]);
		const sessionA = await createRuntime("session-a", dependencies);
		const sessionB = await createRuntime("session-b", dependencies);

		const [resultA, resultB] = await Promise.all([
			sessionA.startRun({ text: "alpha" }).result,
			sessionB.startRun({ text: "beta" }).result,
		]);

		expect(resultA.status).toBe("completed");
		expect(resultB.status).toBe("completed");
		expect(assistantText(resultA.finalMessage)).toContain("LoopIQ Agent");
		expect(assistantText(resultA.finalMessage)).toContain("alpha");
		expect(assistantText(resultA.finalMessage)).not.toContain("beta");
		expect(assistantText(resultB.finalMessage)).toContain("LoopIQ Agent");
		expect(assistantText(resultB.finalMessage)).toContain("beta");
		expect(assistantText(resultB.finalMessage)).not.toContain("alpha");
	});

	it("reserves a run synchronously and rejects a second run", async () => {
		const dependencies = createDependencies({ tokensPerSecond: 1 });
		dependencies.faux.setResponses([fauxAssistantMessage("a deliberately slow response")]);
		const session = await createRuntime("busy-session", dependencies);
		const eventTypes: string[] = [];
		session.subscribe((envelope) => {
			eventTypes.push(envelope.event.type);
		});
		const first = session.startRun({ text: "first" });

		expect(() => session.startRun({ text: "second" })).toThrowError(/busy/i);
		await session.abort(first.runId);
		expect((await first.result).status).toBe("aborted");
		expect(eventTypes.at(-1)).toBe("run_settled");
	});

	it("rejects stale commands without affecting a newer run", async () => {
		const dependencies = createDependencies({ tokensPerSecond: 1 });
		dependencies.faux.setResponses([
			fauxAssistantMessage("done"),
			fauxAssistantMessage("a deliberately slow second response"),
		]);
		const session = await createRuntime("stale-session", dependencies);
		const first = session.startRun({ text: "first" });
		await first.result;
		const second = session.startRun({ text: "second" });

		await expect(session.steer(first.runId, { text: "stale" })).rejects.toThrow(/stale|mismatched/i);
		await expect(session.abort(first.runId)).rejects.toThrow(/stale|mismatched/i);
		expect(session.getSnapshot().currentRunId).toBe(second.runId);
		await session.abort(second.runId);
	});

	it("correlates every run event and terminal event with the accepted runId", async () => {
		const dependencies = createDependencies();
		dependencies.faux.setResponses([fauxAssistantMessage("ok")]);
		const session = await createRuntime("events-session", dependencies);
		const envelopes: Array<{ runId?: string; type: string }> = [];
		let envelopeKeys: string[] | undefined;
		session.subscribe((envelope) => {
			envelopeKeys ??= Object.keys(envelope).sort();
			envelopes.push({ runId: envelope.runId, type: envelope.event.type });
		});

		const handle = session.startRun({ text: "hello" });
		await handle.result;

		expect(envelopes.some((event) => event.type === "message_end")).toBe(true);
		expect(envelopes.at(-1)).toEqual({ runId: handle.runId, type: "run_settled" });
		expect(envelopeKeys).toEqual(["event", "runId", "runtimeId", "sequence", "sessionId", "timestamp"]);
		expect(envelopes.filter((event) => event.type !== "abort").every((event) => event.runId === handle.runId)).toBe(
			true,
		);
	});

	it("emits bounded assistant deltas without repeated partial messages", async () => {
		const dependencies = createDependencies({ tokenSize: 10 });
		const shortText = "a".repeat(400);
		const longText = "b".repeat(4_000);
		dependencies.faux.setResponses([fauxAssistantMessage(shortText), fauxAssistantMessage(longText)]);
		const session = await createRuntime("bounded-progress", dependencies);
		const progress = new Map<string, { bytes: number; text: string }>();
		session.subscribe((envelope) => {
			if (!envelope.runId || envelope.event.type !== "message_update") return;
			expect(Object.keys(envelope.event)).toEqual(["type", "update"]);
			expect(envelope.event.update).not.toHaveProperty("partial");
			const current = progress.get(envelope.runId) ?? { bytes: 0, text: "" };
			current.bytes += JSON.stringify(envelope.event).length;
			if (envelope.event.update.type === "text_delta") current.text += envelope.event.update.delta;
			progress.set(envelope.runId, current);
		});

		const shortRun = session.startRun({ text: "short" });
		await shortRun.result;
		const longRun = session.startRun({ text: "long" });
		await longRun.result;

		expect(progress.get(shortRun.runId)?.text).toBe(shortText);
		expect(progress.get(longRun.runId)?.text).toBe(longText);
		expect(progress.get(longRun.runId)!.bytes).toBeLessThan(progress.get(shortRun.runId)!.bytes * 12);
	});

	it("interrupts only provider inference for steering and continues the same run", async () => {
		const dependencies = createDependencies({ tokensPerSecond: 20 });
		dependencies.faux.setResponses([
			fauxAssistantMessage("this response should be interrupted before it finishes streaming"),
			(context) => fauxAssistantMessage(`continued:${JSON.stringify(context.messages.at(-1))}`),
		]);
		const session = await createRuntime("interrupt-session", dependencies);
		let resolveAssistantStart!: () => void;
		const assistantStarted = new Promise<void>((resolve) => {
			resolveAssistantStart = resolve;
		});
		session.subscribe((envelope) => {
			if (envelope.event.type === "message_start" && envelope.event.message.role === "assistant") {
				resolveAssistantStart();
			}
		});
		const handle = session.startRun({ text: "initial" });
		await assistantStarted;
		await session.steer(handle.runId, { text: "redirect" }, { interruptCurrentInference: true });
		const result = await handle.result;

		expect(result.status).toBe("completed");
		expect(assistantText(result.finalMessage)).toContain("continued");
		expect(assistantText(result.finalMessage)).toContain("redirect");
		expect(result.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(
			true,
		);
	});
});
