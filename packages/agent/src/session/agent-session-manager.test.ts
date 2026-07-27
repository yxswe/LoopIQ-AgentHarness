import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER_REQUEST_POLICY } from "../base/options.ts";
import { AgentEngine } from "../engine/agent-engine.ts";
import { AgentSessionManager } from "./agent-session-manager.ts";

const directories: string[] = [];
const managers: AgentSessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdown({ abortRunning: true }).catch(() => undefined);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "loopiq-manager-data-"));
	const cwd = await mkdtemp(join(tmpdir(), "loopiq-manager-cwd-"));
	directories.push(dataDir, cwd);
	const faux = fauxProvider({ provider: `manager-faux-${Math.random()}` });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const engine = new AgentEngine({
		models,
		getProviderRequestPolicy: () => DEFAULT_PROVIDER_REQUEST_POLICY,
	});
	const createManager = () =>
		new AgentSessionManager(
			dataDir,
			engine,
			() => ({
				model: { providerId: model.provider, modelId: model.id },
				thinkingLevel: "high" as const,
			}),
			async (reference) => engine.resolveModel(reference),
		);
	const manager = createManager();
	managers.push(manager);
	return { dataDir, cwd, faux, model, models, createManager, manager };
}

describe("AgentSessionManager", () => {
	it("returns one loaded runtime for concurrent opens and reconstructs it after close", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("first")]);
		const created = await fixture.manager.create({ cwd: fixture.cwd });
		const id = created.id;

		const [openedA, openedB] = await Promise.all([fixture.manager.open(id), fixture.manager.open(id)]);
		expect(openedA).toBe(created);
		expect(openedB).toBe(created);
		await created.startRun({ text: "hello" }).result;
		await created.updateConfiguration({ thinkingLevel: "low" });
		await fixture.manager.close(id);

		const reopened = await fixture.manager.open(id);
		expect(reopened).not.toBe(created);
		expect(reopened.getSnapshot()).toMatchObject({ id, state: "idle", thinkingLevel: "low" });
		const summaries = await fixture.manager.list();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ id, cwd: fixture.cwd });
	});

	it("rejects a duplicate writable open from another manager", async () => {
		const fixture = await createFixture();
		const session = await fixture.manager.create({ cwd: fixture.cwd });
		const competing = fixture.createManager();
		managers.push(competing);

		await expect(competing.open(session.id)).rejects.toMatchObject({ code: "session_locked" });
		const thirdManager = fixture.createManager();
		managers.push(thirdManager);
		await expect(thirdManager.open(session.id)).rejects.toMatchObject({ code: "session_locked" });
	});

	it("does not close or delete a running Session", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("done");
			},
		]);
		const session = await fixture.manager.create({ cwd: fixture.cwd });
		const handle = session.startRun({ text: "hello" });

		await expect(fixture.manager.close(session.id)).rejects.toMatchObject({ code: "busy" });
		expect(await fixture.manager.open(session.id)).toBe(session);
		const competing = fixture.createManager();
		managers.push(competing);
		await expect(competing.open(session.id)).rejects.toMatchObject({ code: "session_locked" });
		await session.abort(handle.runId);
		await fixture.manager.delete(session.id);
		expect(await fixture.manager.list()).toEqual([]);
	});
});
