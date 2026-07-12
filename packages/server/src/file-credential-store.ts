import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialStore } from "@loopiq/ai";

/**
 * File-backed CredentialStore. Persists a { [providerId]: Credential } map as
 * JSON. Every write persists the whole file, so all writes (modify + delete,
 * across all providers) are serialized through a single in-process promise
 * chain to avoid lost updates. Single-process only (dev tool).
 */
export class FileCredentialStore implements CredentialStore {
	private readonly filePath: string;
	private chain: Promise<unknown> = Promise.resolve();

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	/** Serialize all writes through one global chain. */
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.chain;
		const next = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		this.chain = next.catch(() => {});
		return next;
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
		return this.enqueue(async () => {
			const map = await this.load();
			const next = await fn(map[providerId]);
			if (next !== undefined) {
				map[providerId] = next;
				await this.save(map);
			}
			return map[providerId];
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.enqueue(async () => {
			const map = await this.load();
			delete map[providerId];
			await this.save(map);
		});
	}
}
