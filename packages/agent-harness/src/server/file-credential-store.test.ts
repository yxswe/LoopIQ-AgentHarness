import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Credential } from "@loopiq/ai";
import { FileCredentialStore } from "./file-credential-store.ts";

describe("FileCredentialStore", () => {
	let dir: string;
	let filePath: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "devui-cred-"));
		filePath = join(dir, "credentials.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const oauth: Credential = {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: 0,
	} as Credential;

	it("returns undefined when nothing is stored", async () => {
		const store = new FileCredentialStore(filePath);
		expect(await store.read("github-copilot")).toBeUndefined();
	});

	it("modify writes and read returns the stored credential", async () => {
		const store = new FileCredentialStore(filePath);
		const result = await store.modify("github-copilot", async () => oauth);
		expect(result).toEqual(oauth);
		expect(await store.read("github-copilot")).toEqual(oauth);
	});

	it("persists across instances backed by the same file", async () => {
		await new FileCredentialStore(filePath).modify("github-copilot", async () => oauth);
		const reopened = new FileCredentialStore(filePath);
		expect(await reopened.read("github-copilot")).toEqual(oauth);
	});

	it("modify sees the current credential and can leave it unchanged", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("github-copilot", async () => oauth);
		const seen: Credential | undefined = await new Promise((resolve) => {
			store.modify("github-copilot", async (current) => {
				resolve(current);
				return undefined; // leave unchanged
			});
		});
		expect(seen).toEqual(oauth);
		expect(await store.read("github-copilot")).toEqual(oauth);
	});

	it("delete removes the credential", async () => {
		const store = new FileCredentialStore(filePath);
		await store.modify("github-copilot", async () => oauth);
		await store.delete("github-copilot");
		expect(await store.read("github-copilot")).toBeUndefined();
	});

	it("serializes concurrent writes across different providers", async () => {
		const store = new FileCredentialStore(filePath);
		const other: Credential = {
			type: "oauth",
			access: "other-access",
			refresh: "other-refresh",
			expires: 0,
		} as Credential;
		// Start both without awaiting the first; a per-provider chain would let
		// one whole-file write clobber the other.
		await Promise.all([
			store.modify("github-copilot", async () => oauth),
			store.modify("anthropic", async () => other),
		]);
		expect(await store.read("github-copilot")).toEqual(oauth);
		expect(await store.read("anthropic")).toEqual(other);
	});
});
