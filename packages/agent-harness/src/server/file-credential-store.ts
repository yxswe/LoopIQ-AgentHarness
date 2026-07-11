import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialStore } from "@loopiq/ai";

/**
 * File-backed CredentialStore. Persists a { [providerId]: Credential } map as
 * JSON. Writes are serialized per-provider through an in-process promise chain
 * so refresh/login writes do not race. Single-process only (dev tool).
 */
export class FileCredentialStore implements CredentialStore {
	private readonly filePath: string;
	private chains = new Map<string, Promise<unknown>>();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	private async load(): Promise<Record<string, Credential>> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			return JSON.parse(raw) as Record<string, Credential>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async save(map: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(map, null, 2)}\n`);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const map = await this.load();
		return map[providerId];
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const run = previous.then(async () => {
			const map = await this.load();
			const next = await fn(map[providerId]);
			if (next !== undefined) {
				map[providerId] = next;
				await this.save(map);
			}
			return map[providerId];
		});
		// Keep the chain alive even if this run rejects, without unhandled rejection.
		this.chains.set(
			providerId,
			run.then(
				() => undefined,
				() => undefined,
			),
		);
		return run;
	}

	async delete(providerId: string): Promise<void> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const run = previous.then(async () => {
			const map = await this.load();
			delete map[providerId];
			await this.save(map);
		});
		this.chains.set(
			providerId,
			run.then(
				() => undefined,
				() => undefined,
			),
		);
		await run;
	}
}
