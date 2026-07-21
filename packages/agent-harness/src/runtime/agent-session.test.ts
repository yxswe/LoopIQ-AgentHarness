import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentEngine } from "../engine/agent-engine.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { JsonlSessionStorage } from "../session/jsonl-storage.ts";
import { toSession } from "../session/storage-utils.ts";
import { AgentSession } from "./agent-session.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function createRuntime(name: string, dependencies: ReturnType<typeof createDependencies>): Promise<AgentSession> {
	const directory = await mkdtemp(join(tmpdir(), `loopiq-${name}-`));
	temporaryDirectories.push(directory);
	const env = new NodeExecutionEnv({ cwd: directory });
	const storage = await JsonlSessionStorage.create(env, join(directory, "session.jsonl"), {
		cwd: directory,
		sessionId: name,
	});
	return AgentSession.create({
		env,
		session: toSession(storage),
		engine: dependencies.engine,
		model: dependencies.model,
		systemPrompt: `system-${name}`,
	});
}

function createDependencies(options?: { tokensPerSecond?: number }) {
	const faux = fauxProvider({ provider: `faux-${Math.random()}`, tokensPerSecond: options?.tokensPerSecond });
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, model: faux.getModel(), engine: createAgentEngine({ models }) };
}

function assistantText(message: { content: Array<{ type: string; text?: string }> } | undefined): string {
	return message?.content.map((content) => (content.type === "text" ? content.text : "")).join("") ?? "";
}

describe("AgentSession", () => {
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
		expect(assistantText(resultA.finalMessage)).toContain("system-session-a");
		expect(assistantText(resultA.finalMessage)).toContain("alpha");
		expect(assistantText(resultA.finalMessage)).not.toContain("beta");
		expect(assistantText(resultB.finalMessage)).toContain("system-session-b");
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
		expect(eventTypes).toContain("abort");
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
		session.subscribe((envelope) => {
			envelopes.push({ runId: envelope.runId, type: envelope.event.type });
		});

		const handle = session.startRun({ text: "hello" });
		await handle.result;

		expect(envelopes.some((event) => event.type === "message_end")).toBe(true);
		expect(envelopes.at(-1)).toEqual({ runId: handle.runId, type: "run_settled" });
		expect(envelopes.filter((event) => event.type !== "abort").every((event) => event.runId === handle.runId)).toBe(
			true,
		);
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
