import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Models } from "@loopiq/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../base/messages.ts";
import { AgentHarness } from "../core/agent-harness.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { JsonlSessionStorage } from "./jsonl-storage.ts";
import { Session } from "./session.ts";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("linear JSONL sessions", () => {
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

	it("creates a v4 file and reopens entries in append order", async () => {
		const storage = await JsonlSessionStorage.create(env, sessionPath, {
			cwd: directory,
			sessionId: "session-1",
		});
		const session = new Session(storage);

		await session.appendMessage(userMessage("hello"));
		await session.appendCustomEntry("checkpoint", { value: 1 });
		await session.appendCustomMessageEntry("notice", "visible", true);

		const lines = (await readFile(sessionPath, "utf8")).trim().split("\n").map(JSON.parse);
		expect(lines[0]).toMatchObject({ type: "session", version: 4, id: "session-1", cwd: directory });
		expect(lines.slice(1).map((entry) => entry.type)).toEqual(["message", "custom", "custom_message"]);
		expect(lines.slice(1).every((entry) => !("parentId" in entry))).toBe(true);

		const reopened = new Session(await JsonlSessionStorage.open(env, sessionPath));
		expect((await reopened.getEntries()).map((entry) => entry.type)).toEqual(["message", "custom", "custom_message"]);
		expect((await reopened.buildContext()).messages.map((message) => message.role)).toEqual(["user", "custom"]);
	});

	it("returns entry snapshots that cannot mutate storage ordering", async () => {
		const storage = await JsonlSessionStorage.create(env, sessionPath, {
			cwd: directory,
			sessionId: "session-2",
		});
		const session = new Session(storage);
		await session.appendMessage(userMessage("hello"));

		const snapshot = await storage.getEntries();
		snapshot.length = 0;

		expect(await storage.getEntries()).toHaveLength(1);
	});

	it("rejects legacy tree sessions instead of misreading their leaf", async () => {
		const legacyLines = [
			{ type: "session", version: 3, id: "legacy", timestamp: new Date().toISOString(), cwd: directory },
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: userMessage("legacy"),
			},
			{
				type: "leaf",
				id: "leaf-1",
				parentId: "message-1",
				targetId: null,
				timestamp: new Date().toISOString(),
			},
		];
		await writeFile(sessionPath, `${legacyLines.map(JSON.stringify).join("\n")}\n`);

		await expect(JsonlSessionStorage.open(env, sessionPath)).rejects.toThrow("expected linear session version 4");
	});

	it("rejects unsupported entry types and duplicate ids", async () => {
		const header = {
			type: "session",
			version: 4,
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
			`${[header, message, { ...message, type: "leaf" }].map(JSON.stringify).join("\n")}\n`,
		);
		await expect(JsonlSessionStorage.open(env, sessionPath)).rejects.toThrow("unsupported entry type leaf");

		await writeFile(sessionPath, `${[header, message, message].map(JSON.stringify).join("\n")}\n`);
		await expect(JsonlSessionStorage.open(env, sessionPath)).rejects.toThrow("duplicates entry id duplicate");
	});

	it("rejects tree fields and invalid compaction boundaries in v4 files", async () => {
		const header = {
			type: "session",
			version: 4,
			id: "session-4",
			timestamp: new Date().toISOString(),
			cwd: directory,
		};
		const message = {
			type: "message",
			id: "message-1",
			timestamp: new Date().toISOString(),
			message: userMessage("hello"),
		};

		await writeFile(sessionPath, `${[header, { ...message, parentId: null }].map(JSON.stringify).join("\n")}\n`);
		await expect(JsonlSessionStorage.open(env, sessionPath)).rejects.toThrow("must not contain parentId");

		const compaction = {
			type: "compaction",
			id: "compaction-1",
			timestamp: new Date().toISOString(),
			summary: "summary",
			firstKeptEntryId: "missing",
			tokensBefore: 100,
		};
		await writeFile(sessionPath, `${[header, message, compaction].map(JSON.stringify).join("\n")}\n`);
		await expect(JsonlSessionStorage.open(env, sessionPath)).rejects.toThrow(
			"references unknown firstKeptEntryId missing",
		);
	});

	it("does not overwrite an existing incompatible session", async () => {
		const original = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "legacy",
			timestamp: new Date().toISOString(),
			cwd: directory,
		})}\n`;
		await writeFile(sessionPath, original);

		await expect(
			AgentHarness.create({
				cwd: directory,
				sessionPath,
				models: {} as Models,
				model: { provider: "test", id: "test" } as Model<any>,
			}),
		).rejects.toThrow("expected linear session version 4");
		expect(await readFile(sessionPath, "utf8")).toBe(original);
	});
});
