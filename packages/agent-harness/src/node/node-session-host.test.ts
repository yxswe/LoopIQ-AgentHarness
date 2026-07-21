import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@loopiq/ai";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSessionHost } from "./node-session-host.ts";

const directories: string[] = [];
const hosts: NodeSessionHost[] = [];

afterEach(async () => {
	for (const host of hosts.splice(0)) await host.shutdown({ abortRunning: true }).catch(() => undefined);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
	const dataDir = await mkdtemp(join(tmpdir(), "loopiq-host-data-"));
	const cwd = await mkdtemp(join(tmpdir(), "loopiq-host-cwd-"));
	directories.push(dataDir, cwd);
	const faux = fauxProvider({ provider: `host-faux-${Math.random()}` });
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const options = {
		dataDir,
		models,
		defaultModel: { providerId: model.provider, modelId: model.id },
	};
	const host = new NodeSessionHost(options);
	hosts.push(host);
	return { dataDir, cwd, faux, model, models, options, host };
}

describe("NodeSessionHost", () => {
	it("returns one loaded runtime for concurrent opens and reconstructs it after close", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("first")]);
		const created = await fixture.host.create({ cwd: fixture.cwd });
		const id = created.id;

		const [openedA, openedB] = await Promise.all([fixture.host.open(id), fixture.host.open(id)]);
		expect(openedA).toBe(created);
		expect(openedB).toBe(created);
		await created.startRun({ text: "hello" }).result;
		await created.setThinkingLevel("high");
		await fixture.host.close(id);

		const reopened = await fixture.host.open(id);
		expect(reopened).not.toBe(created);
		expect(reopened.getSnapshot()).toMatchObject({ id, state: "idle", thinkingLevel: "high" });
		const summaries = await fixture.host.list();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({ id, cwd: fixture.cwd });
	});

	it("rejects a duplicate writable open from another host", async () => {
		const fixture = await createFixture();
		const session = await fixture.host.create({ cwd: fixture.cwd });
		const competing = new NodeSessionHost(fixture.options);
		hosts.push(competing);

		await expect(competing.open(session.id)).rejects.toMatchObject({ code: "session_locked" });
		const thirdHost = new NodeSessionHost(fixture.options);
		hosts.push(thirdHost);
		await expect(thirdHost.open(session.id)).rejects.toMatchObject({ code: "session_locked" });
	});

	it("does not close or delete a running Session", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return fauxAssistantMessage("done");
			},
		]);
		const session = await fixture.host.create({ cwd: fixture.cwd });
		const handle = session.startRun({ text: "hello" });

		await expect(fixture.host.close(session.id)).rejects.toMatchObject({ code: "busy" });
		await session.abort(handle.runId);
		await fixture.host.delete(session.id);
		expect(await fixture.host.list()).toEqual([]);
	});
});
