import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createModels } from "@loopiq/ai";
import { githubCopilotProvider } from "@loopiq/ai/providers/github-copilot";
import { AgentHarness } from "../core/agent-harness.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { JsonlSessionStorage } from "../session/jsonl-storage.ts";
import { Session } from "../session/session.ts";
import { ensureCopilotCredential } from "./copilot-auth.ts";
import { FileCredentialStore } from "./file-credential-store.ts";

const PROVIDER_ID = "github-copilot";

export interface DevHarness {
	harness: AgentHarness;
	modelId: string;
}

export interface CreateDevHarnessOptions {
	dataDir: string;
	cwd: string;
	modelId: string;
}

export async function createDefaultHarness(options: CreateDevHarnessOptions): Promise<DevHarness> {
	const store = new FileCredentialStore(join(options.dataDir, "credentials.json"));
	await ensureCopilotCredential(store);

	const models = createModels({ credentials: store });
	models.setProvider(githubCopilotProvider());

	let model = models.getModel(PROVIDER_ID, options.modelId);
	if (!model) {
		// Builtin lists may need a refresh to populate; retry once.
		await models.refresh(PROVIDER_ID);
		model = models.getModel(PROVIDER_ID, options.modelId);
	}
	if (!model) {
		const available = models
			.getModels(PROVIDER_ID)
			.map((m) => m.id)
			.join(", ");
		throw new Error(
			`Model "${options.modelId}" not found for provider "${PROVIDER_ID}". Available: ${available || "(none)"}`,
		);
	}

	const env = new NodeExecutionEnv({ cwd: options.cwd });
	const sessionPath = join(options.dataDir, "session.jsonl");
	const storage = await openOrCreateSessionStorage(env, sessionPath, options.cwd);
	const session = new Session(storage);

	const harness = new AgentHarness({
		env,
		session,
		models,
		model,
		systemPrompt: "You are a helpful assistant running inside the AgentHarness devui.",
		tools: [],
	});

	return { harness, modelId: model.id };
}

async function openOrCreateSessionStorage(
	env: NodeExecutionEnv,
	sessionPath: string,
	cwd: string,
): Promise<JsonlSessionStorage> {
	const existing = await env.readTextFile(sessionPath);
	if (existing.ok) {
		return JsonlSessionStorage.open(env, sessionPath);
	}
	return JsonlSessionStorage.create(env, sessionPath, { cwd, sessionId: randomUUID() });
}
