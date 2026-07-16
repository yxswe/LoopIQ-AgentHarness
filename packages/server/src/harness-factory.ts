import { join } from "node:path";
import { AgentHarness, createDefaultTools, NodeExecutionEnv } from "@loopiq/agent-core";
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
