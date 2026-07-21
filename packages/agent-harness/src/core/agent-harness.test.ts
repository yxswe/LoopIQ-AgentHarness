import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "./agent-harness.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AgentHarness compatibility facade", () => {
	it("maps an explicit AgentSession run back to the legacy assistant result and naked events", async () => {
		const directory = await mkdtemp(join(tmpdir(), "loopiq-harness-"));
		directories.push(directory);
		const faux = fauxProvider({ provider: `harness-faux-${Math.random()}` });
		faux.setResponses([fauxAssistantMessage("legacy-result")]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await AgentHarness.create({
			cwd: directory,
			sessionPath: join(directory, "session.jsonl"),
			models,
			model: faux.getModel(),
		});
		const eventTypes: string[] = [];
		harness.subscribe((event) => {
			eventTypes.push(event.type);
		});

		const result = await harness.send("hello");

		expect(result?.role).toBe("assistant");
		expect(result?.content).toContainEqual({ type: "text", text: "legacy-result" });
		expect(eventTypes).toContain("agent_end");
		expect(eventTypes).toContain("settled");
	});
});
