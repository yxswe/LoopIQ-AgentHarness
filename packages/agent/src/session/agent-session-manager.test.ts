import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
	const agentHome = await mkdtemp(join(tmpdir(), "loopiq-manager-home-"));
	const workspaceDir = await mkdtemp(join(tmpdir(), "loopiq-manager-workspace-"));
	directories.push(agentHome, workspaceDir);
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
			agentHome,
			engine,
			() => ({
				model: { providerId: model.provider, modelId: model.id },
				thinkingLevel: "high" as const,
			}),
			async (reference) => engine.resolveModel(reference),
		);
	const manager = createManager();
	managers.push(manager);
	return { agentHome, workspaceDir, faux, model, models, createManager, manager };
}

describe("AgentSessionManager", () => {
	it("returns one loaded runtime for concurrent opens and reconstructs it after close", async () => {
		const fixture = await createFixture();
		fixture.faux.setResponses([fauxAssistantMessage("first")]);
		const relativeWorkspace = relative(process.cwd(), fixture.workspaceDir);
		const created = await fixture.manager.create({ workspaceDir: relativeWorkspace });
		const id = created.id;
		expect(created.getSnapshot().workspaceDir).toBe(resolve(relativeWorkspace));
		expect(await readFile(join(fixture.agentHome, "sessions", id, "session.jsonl"), "utf8")).toContain(
			`"workspaceDir":"${fixture.workspaceDir}"`,
		);
		await expect(readFile(join(fixture.workspaceDir, "session.jsonl"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});

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
		expect(summaries[0]).toMatchObject({ id, workspaceDir: fixture.workspaceDir });
	});

	it("rejects a duplicate writable open from another manager", async () => {
		const fixture = await createFixture();
		const session = await fixture.manager.create({ workspaceDir: fixture.workspaceDir });
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
		const session = await fixture.manager.create({ workspaceDir: fixture.workspaceDir });
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

	it("rejects missing and non-directory Workspaces before creating a Session", async () => {
		const fixture = await createFixture();
		const missing = join(fixture.workspaceDir, "missing");
		await expect(fixture.manager.create({ workspaceDir: missing })).rejects.toMatchObject({
			code: "invalid_argument",
		});

		const filePath = join(fixture.workspaceDir, "file.txt");
		await writeFile(filePath, "not a directory");
		await expect(fixture.manager.create({ workspaceDir: filePath })).rejects.toMatchObject({
			code: "invalid_argument",
		});
		expect(await fixture.manager.list()).toEqual([]);
	});

	it("rejects reopening a Session whose Workspace no longer exists", async () => {
		const fixture = await createFixture();
		const session = await fixture.manager.create({ workspaceDir: fixture.workspaceDir });
		await fixture.manager.close(session.id);
		await rm(fixture.workspaceDir, { recursive: true, force: true });

		await expect(fixture.manager.open(session.id)).rejects.toMatchObject({ code: "invalid_argument" });
	});
});
