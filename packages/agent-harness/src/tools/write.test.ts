import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createFileAccessTracker } from "./utils/file-access-tracker.ts";
import { createWriteTool } from "./write.ts";

describe("Write tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "write-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("creates a new file with the given content", async () => {
		const tool = createWriteTool(env);
		const result = await tool.execute("call-1", { file_path: "out.txt", content: "hello" });
		expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("hello");
		expect(result.details.created).toBe(true);
		expect(result.details.bytesWritten).toBe(5);
	});

	it("overwrites an existing file and reports created=false", async () => {
		const tool = createWriteTool(env);
		await tool.execute("call-1", { file_path: "out.txt", content: "first" });
		const result = await tool.execute("call-2", { file_path: "out.txt", content: "second" });
		expect(await readFile(join(dir, "out.txt"), "utf8")).toBe("second");
		expect(result.details.created).toBe(false);
	});

	it("creates parent directories as needed", async () => {
		const tool = createWriteTool(env);
		await tool.execute("call-1", { file_path: "nested/deep/out.txt", content: "x" });
		expect(await readFile(join(dir, "nested/deep/out.txt"), "utf8")).toBe("x");
	});

	it("throws when the target path is a directory", async () => {
		const tool = createWriteTool(env);
		await expect(tool.execute("call-1", { file_path: ".", content: "x" })).rejects.toThrow();
	});

	it("refuses to overwrite an existing file that was not read (with tracker)", async () => {
		await writeFile(join(dir, "guard.txt"), "existing");
		const tracker = createFileAccessTracker();
		const tool = createWriteTool(env, tracker);
		await expect(tool.execute("call-1", { file_path: "guard.txt", content: "new" })).rejects.toThrow(/read/i);
		expect(await readFile(join(dir, "guard.txt"), "utf8")).toBe("existing");
	});

	it("allows overwrite after the file was read (with tracker)", async () => {
		await writeFile(join(dir, "guard.txt"), "existing");
		const info = await stat(join(dir, "guard.txt"));
		const tracker = createFileAccessTracker();
		tracker.markRead(join(dir, "guard.txt"), info.mtimeMs);
		const tool = createWriteTool(env, tracker);
		const result = await tool.execute("call-1", { file_path: "guard.txt", content: "new" });
		expect(result.details.created).toBe(false);
		expect(await readFile(join(dir, "guard.txt"), "utf8")).toBe("new");
	});

	it("allows overwrite of a file it wrote itself (with tracker)", async () => {
		const tracker = createFileAccessTracker();
		const tool = createWriteTool(env, tracker);
		await tool.execute("call-1", { file_path: "self.txt", content: "first" });
		const result = await tool.execute("call-2", { file_path: "self.txt", content: "second" });
		expect(await readFile(join(dir, "self.txt"), "utf8")).toBe("second");
		expect(result.details.created).toBe(false);
	});

	it("appends to an existing file without requiring a prior read", async () => {
		await writeFile(join(dir, "log.txt"), "a\n");
		const tracker = createFileAccessTracker();
		const tool = createWriteTool(env, tracker);
		const result = await tool.execute("call-1", { file_path: "log.txt", content: "b\n", append: true });
		expect(await readFile(join(dir, "log.txt"), "utf8")).toBe("a\nb\n");
		expect(result.details.appended).toBe(true);
	});
});
