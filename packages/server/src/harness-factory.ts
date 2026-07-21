import { join } from "node:path";
import {
	AgentHarness,
	type AgentSession,
	createDefaultTools,
	createNodeSessionHost,
	NodeExecutionEnv,
	type NodeSessionHost,
} from "@loopiq/agent-core";
import { createModels } from "@loopiq/ai";
import { githubCopilotProvider } from "@loopiq/ai/providers/github-copilot";
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

export interface DevRuntime {
	host: NodeSessionHost;
	defaultSession: AgentSession;
	modelId: string;
}

async function createModelsAndModel(options: CreateDevHarnessOptions) {
	const store = new FileCredentialStore(join(options.dataDir, "credentials.json"));
	await ensureCopilotCredential(store);

	const models = createModels({ credentials: store });
	models.setProvider(githubCopilotProvider());

	let model = models.getModel(PROVIDER_ID, options.modelId);
	if (!model) {
		await models.refresh(PROVIDER_ID);
		model = models.getModel(PROVIDER_ID, options.modelId);
	}
	if (!model) {
		const available = models
			.getModels(PROVIDER_ID)
			.map((candidate) => candidate.id)
			.join(", ");
		throw new Error(
			`Model "${options.modelId}" not found for provider "${PROVIDER_ID}". Available: ${available || "(none)"}`,
		);
	}
	return { models, model };
}

export async function createDefaultHarness(options: CreateDevHarnessOptions): Promise<DevHarness> {
	const { models, model } = await createModelsAndModel(options);

	const harness = await AgentHarness.create({
		cwd: options.cwd,
		sessionPath: join(options.dataDir, "session.jsonl"),
		models,
		model,
		systemPrompt: "You are a helpful assistant running inside the AgentHarness devui.",
		tools: createDefaultTools(new NodeExecutionEnv({ cwd: options.cwd })),
	});

	return { harness, modelId: model.id };
}

export async function createDefaultRuntime(options: CreateDevHarnessOptions): Promise<DevRuntime> {
	const { models, model } = await createModelsAndModel(options);
	const host = createNodeSessionHost({
		dataDir: options.dataDir,
		models,
		defaultModel: { providerId: model.provider, modelId: model.id },
		systemPrompt: "You are a helpful assistant running inside the AgentHarness devui.",
		createTools: (env) => createDefaultTools(env),
	});
	const existing = await host.list();
	const defaultSession = existing[0]
		? await host.open(existing[0].id)
		: await host.create({
				cwd: options.cwd,
				model: { providerId: model.provider, modelId: model.id },
			});
	return { host, defaultSession, modelId: model.id };
}
