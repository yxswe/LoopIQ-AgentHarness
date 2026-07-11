import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { CredentialStore } from "@loopiq/ai";
import { loginGitHubCopilot } from "@loopiq/ai/oauth";

const PROVIDER_ID = "github-copilot";

async function promptLine(message: string): Promise<string> {
	const rl = createInterface({ input: stdin, output: stdout });
	try {
		return await rl.question(`${message} `);
	} finally {
		rl.close();
	}
}

/**
 * Ensure a usable GitHub Copilot credential exists.
 *
 * - If COPILOT_GITHUB_TOKEN is set, the provider's env-var api-key path is used;
 *   no device login is needed.
 * - Else if the store already holds a credential, reuse it.
 * - Else run the device-code login flow and persist the credential.
 */
export async function ensureCopilotCredential(store: CredentialStore): Promise<void> {
	if (process.env.COPILOT_GITHUB_TOKEN) {
		console.log("[devui] Using COPILOT_GITHUB_TOKEN from environment.");
		return;
	}

	const existing = await store.read(PROVIDER_ID);
	if (existing) {
		console.log("[devui] Reusing stored GitHub Copilot credential.");
		return;
	}

	console.log("[devui] No GitHub Copilot credential found. Starting device login...");
	const credentials = await loginGitHubCopilot({
		onDeviceCode: (info) => {
			console.log("\n=== GitHub Copilot login ===");
			console.log(`Open: ${info.verificationUri}`);
			console.log(`Enter code: ${info.userCode}`);
			console.log(`(expires in ${info.expiresInSeconds}s)\n`);
		},
		onPrompt: (prompt) => promptLine(prompt.message),
		onProgress: (message) => console.log(`[devui] ${message}`),
	});

	await store.modify(PROVIDER_ID, async () => ({ ...credentials, type: "oauth" }));
	console.log("[devui] GitHub Copilot credential stored.");
}
