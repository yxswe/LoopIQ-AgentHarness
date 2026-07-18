import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { countOccurrences, createEditTool } from "./edit.ts";
import { createFileAccessTracker } from "./utils/file-access-tracker.ts";

describe("Edit tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "edit-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("countOccurrences counts non-overlapping matches", () => {
		expect(countOccurrences("a-b-c", "-")).toBe(2);
		expect(countOccurrences("aaa", "aa")).toBe(1);
		expect(countOccurrences("abc", "z")).toBe(0);
	});

	it("replaces a unique occurrence", async () => {
		await writeFile(join(dir, "f.txt"), "const a = 1;\nconst b = 2;\n");
		const tool = createEditTool(env);
		const result = await tool.execute("call-1", { file_path: "f.txt", old_string: "b = 2", new_string: "b = 99" });
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("const a = 1;\nconst b = 99;\n");
		expect(result.details.replacements).toBe(1);
	});

	it("replaces all occurrences with replace_all", async () => {
		await writeFile(join(dir, "f.txt"), "x x x");
		const tool = createEditTool(env);
		const result = await tool.execute("call-1", {
			file_path: "f.txt",
			old_string: "x",
			new_string: "y",
			replace_all: true,
		});
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("y y y");
		expect(result.details.replacements).toBe(3);
	});

	it("throws when old_string is not found", async () => {
		await writeFile(join(dir, "f.txt"), "hello");
		const tool = createEditTool(env);
		await expect(
			tool.execute("call-1", { file_path: "f.txt", old_string: "absent", new_string: "x" }),
		).rejects.toThrow(/not found/i);
	});

	it("throws when old_string is not unique and replace_all is false", async () => {
		await writeFile(join(dir, "f.txt"), "x x");
		const tool = createEditTool(env);
		await expect(
			tool.execute("call-1", { file_path: "f.txt", old_string: "x", new_string: "y" }),
		).rejects.toThrow(/unique|multiple|occurrence/i);
	});

	it("applies multiple edits sequentially with the edits array", async () => {
		await writeFile(join(dir, "f.txt"), "a b c");
		const tool = createEditTool(env);
		const result = await tool.execute("call-1", {
			file_path: "f.txt",
			edits: [
				{ old_string: "a", new_string: "A" },
				{ old_string: "c", new_string: "C" },
			],
		});
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("A b C");
		expect(result.details.replacements).toBe(2);
		expect(result.details.edits).toBe(2);
	});

	it("chains edits where a later edit depends on an earlier one", async () => {
		await writeFile(join(dir, "f.txt"), "foo");
		const tool = createEditTool(env);
		await tool.execute("call-1", {
			file_path: "f.txt",
			edits: [
				{ old_string: "foo", new_string: "bar" },
				{ old_string: "bar", new_string: "baz" },
			],
		});
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("baz");
	});

	it("fails atomically when one edit in the array does not apply", async () => {
		await writeFile(join(dir, "f.txt"), "x");
		const tool = createEditTool(env);
		await expect(
			tool.execute("call-1", {
				file_path: "f.txt",
				edits: [
					{ old_string: "x", new_string: "y" },
					{ old_string: "absent", new_string: "z" },
				],
			}),
		).rejects.toThrow(/not found/i);
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("x");
	});

	it("throws when neither old_string nor edits are provided", async () => {
		await writeFile(join(dir, "f.txt"), "x");
		const tool = createEditTool(env);
		await expect(tool.execute("call-1", { file_path: "f.txt" })).rejects.toThrow(/old_string|edits/i);
	});

	it("refuses to edit a file that was not read (with tracker)", async () => {
		await writeFile(join(dir, "f.txt"), "hello");
		const tracker = createFileAccessTracker();
		const tool = createEditTool(env, tracker);
		await expect(
			tool.execute("call-1", { file_path: "f.txt", old_string: "hello", new_string: "world" }),
		).rejects.toThrow(/read/i);
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("hello");
	});

	it("allows editing after the file was read (with tracker)", async () => {
		await writeFile(join(dir, "f.txt"), "hello");
		const info = await stat(join(dir, "f.txt"));
		const tracker = createFileAccessTracker();
		tracker.markRead(join(dir, "f.txt"), info.mtimeMs);
		const tool = createEditTool(env, tracker);
		await tool.execute("call-1", { file_path: "f.txt", old_string: "hello", new_string: "world" });
		expect(await readFile(join(dir, "f.txt"), "utf8")).toBe("world");
	});
});
