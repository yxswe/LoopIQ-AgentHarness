import { join } from "node:path";
import type { Credential, CredentialStore } from "@loopiq/ai";
import { AgentRuntimeError, toError } from "../base/types.ts";
import { withFileLock } from "../persistence/file-lock.ts";
import { readJsonFile, writeJsonFileAtomic } from "../persistence/json-file.ts";

type CredentialMap = Record<string, Credential>;

function isCredentialMap(value: unknown): value is CredentialMap {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every(
		(credential) =>
			credential !== null &&
			typeof credential === "object" &&
			((credential as { type?: unknown }).type === "api_key" || (credential as { type?: unknown }).type === "oauth"),
	);
}

export class FileCredentialStore implements CredentialStore {
	private readonly filePath: string;
	private readonly lockPath: string;

	constructor(dataDir: string) {
		this.filePath = join(dataDir, "credentials.json");
		this.lockPath = join(dataDir, "credentials.lock");
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return withFileLock(this.lockPath, async () => {
			const credentials = await this.load();
			const current = credentials[providerId];
			const next = await fn(current);
			if (next === undefined) return current;
			credentials[providerId] = next;
			await this.save(credentials);
			return next;
		});
	}

	async delete(providerId: string): Promise<void> {
		await withFileLock(this.lockPath, async () => {
			const credentials = await this.load();
			if (!(providerId in credentials)) return;
			delete credentials[providerId];
			await this.save(credentials);
		});
	}

	private async load(): Promise<CredentialMap> {
		try {
			const value = await readJsonFile<unknown>(this.filePath);
			if (value === undefined) return {};
			if (!isCredentialMap(value)) throw new Error("Credential file must contain a provider-to-credential object");
			return value;
		} catch (error) {
			throw new AgentRuntimeError("credential_store", "Failed to read credentials", toError(error));
		}
	}

	private async save(credentials: CredentialMap): Promise<void> {
		try {
			await writeJsonFileAtomic(this.filePath, credentials);
		} catch (error) {
			throw new AgentRuntimeError("credential_store", "Failed to save credentials", toError(error));
		}
	}
}
