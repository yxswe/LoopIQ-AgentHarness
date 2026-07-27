import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "./file-credential-store.ts";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
	const dataDir = await mkdtemp(join(tmpdir(), "loopiq-credentials-"));
	directories.push(dataDir);
	return { dataDir, store: new FileCredentialStore(dataDir) };
}

describe("FileCredentialStore", () => {
	it("preserves the current credential when modify returns undefined", async () => {
		const { store } = await createStore();
		await store.modify("openai", async () => ({ type: "api_key", key: "first" }));
		expect(await store.modify("openai", async () => undefined)).toEqual({ type: "api_key", key: "first" });
		expect(await store.read("openai")).toEqual({ type: "api_key", key: "first" });
	});

	it("persists credentials across store instances and deletes explicitly", async () => {
		const { dataDir, store } = await createStore();
		await store.modify("openai", async () => ({ type: "api_key", key: "secret" }));
		const reopened = new FileCredentialStore(dataDir);
		expect(await reopened.read("openai")).toEqual({ type: "api_key", key: "secret" });
		await reopened.delete("openai");
		expect(await store.read("openai")).toBeUndefined();
		expect(JSON.parse(await readFile(join(dataDir, "credentials.json"), "utf8"))).toEqual({});
	});

	it("rejects unsupported credential-file shapes", async () => {
		const { dataDir, store } = await createStore();
		await writeFile(join(dataDir, "credentials.json"), JSON.stringify({ openai: { token: "secret" } }));
		await expect(store.read("openai")).rejects.toMatchObject({ code: "credential_store" });
	});

	it("serializes read-modify-write across store instances", async () => {
		const { dataDir, store } = await createStore();
		const competing = new FileCredentialStore(dataDir);
		await Promise.all([
			store.modify("openai", async () => {
				await new Promise((resolve) => setTimeout(resolve, 25));
				return { type: "api_key", key: "openai" };
			}),
			competing.modify("anthropic", async () => ({ type: "api_key", key: "anthropic" })),
		]);
		expect(await store.read("openai")).toMatchObject({ key: "openai" });
		expect(await store.read("anthropic")).toMatchObject({ key: "anthropic" });
	});

	it("recovers a lock left by a dead process", async () => {
		const { dataDir, store } = await createStore();
		const lockPath = join(dataDir, "credentials.lock");
		await mkdir(lockPath);
		await writeFile(
			join(lockPath, "owner.json"),
			JSON.stringify({ pid: 2_147_483_647, acquiredAt: new Date(0).toISOString() }),
		);
		await store.modify("openai", async () => ({ type: "api_key", key: "recovered" }));
		expect(await store.read("openai")).toMatchObject({ key: "recovered" });
	});
});
