import { join } from "node:path";
import { stderr, stdin } from "node:process";
import { createInterface } from "node:readline/promises";
import { createDefaultTools, createNodeSessionHost } from "@loopiq/agent-core";
import { type CredentialStore, createModels } from "@loopiq/ai";
import { loginGitHubCopilot } from "@loopiq/ai/oauth";
import { githubCopilotProvider } from "@loopiq/ai/providers/github-copilot";
import { FileCredentialStore } from "./file-credential-store.ts";

const PROVIDER_ID = "github-copilot";

async function ensureCredential(store: CredentialStore): Promise<void> {
	if (process.env.COPILOT_GITHUB_TOKEN || (await store.read(PROVIDER_ID))) return;
	console.error("No GitHub Copilot credential found. Starting device login.");
	const credentials = await loginGitHubCopilot({
		onDeviceCode: (info) => {
			console.error(`Open ${info.verificationUri} and enter code ${info.userCode}`);
		},
		onPrompt: async (prompt) => {
			const readline = createInterface({ input: stdin, output: stderr });
			try {
				return await readline.question(`${prompt.message} `);
			} finally {
				readline.close();
			}
		},
		onProgress: (message) => console.error(message),
	});
	await store.modify(PROVIDER_ID, async () => ({ ...credentials, type: "oauth" }));
}

export async function createDefaultRuntime(dataDir: string, modelSpec: string) {
	const separator = modelSpec.indexOf("/");
	if (separator <= 0 || separator === modelSpec.length - 1) throw new Error("Model must use provider/model format");
	const providerId = modelSpec.slice(0, separator);
	const modelId = modelSpec.slice(separator + 1);
	if (providerId !== PROVIDER_ID) throw new Error(`CLI default runtime does not configure provider ${providerId}`);

	const credentials = new FileCredentialStore(join(dataDir, "credentials.json"));
	await ensureCredential(credentials);
	const models = createModels({ credentials });
	models.setProvider(githubCopilotProvider());
	let model = models.getModel(providerId, modelId);
	if (!model) {
		await models.refresh(providerId);
		model = models.getModel(providerId, modelId);
	}
	if (!model) throw new Error(`Unknown model ${modelSpec}`);

	const host = createNodeSessionHost({
		dataDir,
		models,
		defaultModel: { providerId, modelId },
		systemPrompt: "You are a helpful assistant running in the LoopIQ headless CLI.",
		createTools: (env) => createDefaultTools(env),
	});
	return { host, models, model };
}
