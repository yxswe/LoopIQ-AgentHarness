import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../base/messages.ts";
import { NodeExecutionEnv } from "../../env/nodejs.ts";
import { JsonlSessionStore } from "./jsonl-session-store.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("JsonlSessionStore", () => {
	let directory: string;
	let sessionPath: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "loopiq-session-"));
		sessionPath = join(directory, "session.jsonl");
		env = new NodeExecutionEnv({ cwd: directory });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(directory, { recursive: true, force: true });
	});

	it("creates a file and reopens entries in append order", async () => {
		const store = await JsonlSessionStore.create(env, sessionPath, {
			cwd: directory,
			sessionId: "session-1",
		});

		await store.appendMessage(userMessage("hello"));
		await store.appendConfiguration({
			model: { providerId: "test", modelId: "test-model" },
			thinkingLevel: "high",
		});

		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n").map(JSON.parse);
		expect(lines[0]).toEqual(expect.objectContaining({ type: "session", id: "session-1", cwd: directory }));
		expect(Object.keys(lines[0]).sort()).toEqual(["cwd", "id", "timestamp", "type"]);
		expect(lines.slice(1).map((entry) => entry.type)).toEqual(["message", "session_config"]);

		const reopened = await JsonlSessionStore.open(env, sessionPath);
		const restored = reopened.restore();
		expect(restored.messages.map((message) => message.role)).toEqual(["user"]);
		expect(restored.configuration).toEqual({
			model: { providerId: "test", modelId: "test-model" },
			thinkingLevel: "high",
		});
	});

	it("returns restored state that cannot mutate the Store", async () => {
		const store = await JsonlSessionStore.create(env, sessionPath, {
			cwd: directory,
			sessionId: "session-2",
		});
		await store.appendMessage(userMessage("hello"));
		await store.appendConfiguration({
			model: { providerId: "test", modelId: "test-model" },
			thinkingLevel: "high",
		});

		const restored = store.restore();
		restored.messages.length = 0;
		restored.configuration!.model.modelId = "mutated";

		expect(store.restore()).toMatchObject({
			messages: [{ role: "user" }],
			configuration: { model: { modelId: "test-model" } },
		});
	});

	it("serializes concurrent appends", async () => {
		const store = await JsonlSessionStore.create(env, sessionPath, {
			cwd: directory,
			sessionId: "session-concurrent",
		});

		await Promise.all([
			store.appendMessage(userMessage("one")),
			store.appendMessage(userMessage("two")),
			store.appendMessage(userMessage("three")),
		]);

		expect(store.restore().messages.map((message) => (message.role === "user" ? message.content : ""))).toEqual([
			"one",
			"two",
			"three",
		]);
	});

	it("rejects obsolete entry types, malformed configuration, and duplicate ids", async () => {
		const header = {
			type: "session",
			id: "session-3",
			timestamp: new Date().toISOString(),
			cwd: directory,
		};
		const message = {
			type: "message",
			id: "duplicate",
			timestamp: new Date().toISOString(),
			message: userMessage("hello"),
		};

		await writeFile(
			sessionPath,
			`${[header, message, { ...message, type: "custom", customType: "checkpoint" }]
				.map(JSON.stringify)
				.join("\n")}\n`,
		);
		await expect(JsonlSessionStore.open(env, sessionPath)).rejects.toThrow("unsupported entry type custom");

		await writeFile(
			sessionPath,
			`${[
				header,
				{
					type: "session_config",
					id: "config",
					timestamp: new Date().toISOString(),
					configuration: { providerId: "test", modelId: "test-model", thinkingLevel: "high" },
				},
			]
				.map(JSON.stringify)
				.join("\n")}\n`,
		);
		await expect(JsonlSessionStore.open(env, sessionPath)).rejects.toThrow("invalid Session configuration");

		await writeFile(sessionPath, `${[header, message, message].map(JSON.stringify).join("\n")}\n`);
		await expect(JsonlSessionStore.open(env, sessionPath)).rejects.toThrow("duplicates entry id duplicate");
	});

	it("does not overwrite a malformed session while opening", async () => {
		const original = `${JSON.stringify({
			type: "session",
			timestamp: new Date().toISOString(),
			cwd: directory,
		})}\n`;
		await writeFile(sessionPath, original);

		await expect(JsonlSessionStore.open(env, sessionPath)).rejects.toThrow("session header is missing id");
		expect(await readFile(sessionPath, "utf8")).toBe(original);
	});
});
