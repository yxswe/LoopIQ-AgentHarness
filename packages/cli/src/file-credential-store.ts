import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Credential, CredentialStore } from "@loopiq/ai";

export class FileCredentialStore implements CredentialStore {
	private chain: Promise<unknown> = Promise.resolve();
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.chain;
		const next = (async () => {
			await previous.catch(() => undefined);
			return task();
		})();
		this.chain = next.catch(() => undefined);
		return next;
	}

	private async load(): Promise<Record<string, Credential>> {
		try {
			return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, Credential>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async save(credentials: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(credentials, null, 2)}\n`);
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.load())[providerId];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.enqueue(async () => {
			const credentials = await this.load();
			const next = await fn(credentials[providerId]);
			if (next === undefined) delete credentials[providerId];
			else credentials[providerId] = next;
			await this.save(credentials);
			return next;
		});
	}

	async delete(providerId: string): Promise<void> {
		await this.enqueue(async () => {
			const credentials = await this.load();
			delete credentials[providerId];
			await this.save(credentials);
		});
	}
}
