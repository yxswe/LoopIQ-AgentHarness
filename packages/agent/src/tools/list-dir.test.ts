import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createListDirTool } from "./list-dir.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("ListDir tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "list-dir-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
		await writeFile(join(dir, "a.txt"), "a");
		await writeFile(join(dir, "b.txt"), "b");
		await mkdir(join(dir, "sub"));
		await writeFile(join(dir, "sub", "c.txt"), "c");
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("lists direct children and marks directories", async () => {
		const tool = createListDirTool(env);
		const result = await tool.execute("c1", {});
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).toContain("b.txt");
		expect(text).toContain("sub/");
		expect(text).not.toContain("c.txt");
		expect(result.details.entries).toBe(3);
	});

	it("lists an explicit path", async () => {
		const tool = createListDirTool(env);
		const result = await tool.execute("c1", { path: "sub" });
		const text = textOf(result.content);
		expect(text).toContain("c.txt");
		expect(result.details.entries).toBe(1);
	});

	it("lists an empty directory cleanly", async () => {
		await mkdir(join(dir, "empty"));
		const tool = createListDirTool(env);
		const result = await tool.execute("c1", { path: "empty" });
		expect(result.details.entries).toBe(0);
	});

	it("throws when the path does not exist", async () => {
		const tool = createListDirTool(env);
		await expect(tool.execute("c1", { path: "nope" })).rejects.toThrow();
	});

	it("throws when the path is not a directory", async () => {
		const tool = createListDirTool(env);
		await expect(tool.execute("c1", { path: "a.txt" })).rejects.toThrow();
	});

	it("recurses into subdirectories when requested", async () => {
		const tool = createListDirTool(env);
		const result = await tool.execute("c1", { recursive: true });
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).toContain("sub/");
		expect(text).toContain(join("sub", "c.txt"));
		expect(result.details.entries).toBe(4);
	});
});
