import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createReadTool, formatNumberedLines } from "./read.ts";
import { createFileAccessTracker } from "./utils/file-access-tracker.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

/** 1x1 transparent PNG. */
const PNG_1x1_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("Read tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "read-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("reads file contents with 1-based line numbers", async () => {
		await writeFile(join(dir, "a.txt"), "alpha\nbeta\ngamma\n");
		const tool = createReadTool(env);
		const result = await tool.execute("call-1", { file_path: "a.txt" });
		const text = textOf(result.content);
		expect(text).toContain("     1\talpha");
		expect(text).toContain("     3\tgamma");
		expect(result.details.totalLines).toBe(3);
		expect(result.details.returnedLines).toBe(3);
	});

	it("applies offset and limit", async () => {
		await writeFile(join(dir, "b.txt"), "l1\nl2\nl3\nl4\nl5\n");
		const tool = createReadTool(env);
		const result = await tool.execute("call-2", { file_path: "b.txt", offset: 2, limit: 2 });
		const text = textOf(result.content);
		expect(text).toContain("     2\tl2");
		expect(text).toContain("     3\tl3");
		expect(text).not.toContain("l1");
		expect(text).not.toContain("l4");
		expect(result.details.offset).toBe(2);
		expect(result.details.returnedLines).toBe(2);
	});

	it("throws when the file does not exist", async () => {
		const tool = createReadTool(env);
		await expect(tool.execute("call-3", { file_path: "missing.txt" })).rejects.toThrow();
	});

	it("formatNumberedLines pads and tab-separates", () => {
		expect(formatNumberedLines(["x"], 1)).toBe("     1\tx");
		expect(formatNumberedLines(["a", "b"], 9)).toBe("     9\ta\n    10\tb");
	});

	it("defaults to a 2000-line limit when no limit is given", async () => {
		const lines = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`);
		await writeFile(join(dir, "big.txt"), `${lines.join("\n")}\n`);
		const tool = createReadTool(env);
		const result = await tool.execute("call-limit", { file_path: "big.txt" });
		const text = textOf(result.content);
		expect(result.details.totalLines).toBe(2500);
		expect(result.details.returnedLines).toBe(2000);
		expect(result.details.truncated).toBe(true);
		expect(text).toContain("line2000");
		expect(text).not.toContain("line2001");
	});

	it("throws for a very large file when no limit is provided", async () => {
		const big = "x".repeat(300 * 1024);
		await writeFile(join(dir, "huge.txt"), big);
		const tool = createReadTool(env);
		await expect(tool.execute("call-huge", { file_path: "huge.txt" })).rejects.toThrow(/limit|offset/i);
	});

	it("reads a windowed slice of a very large file when limit is provided", async () => {
		const linesArr = Array.from({ length: 20000 }, (_, i) => `row${i + 1}`);
		await writeFile(join(dir, "huge2.txt"), `${linesArr.join("\n")}\n`);
		const tool = createReadTool(env);
		const result = await tool.execute("call-window", { file_path: "huge2.txt", offset: 10, limit: 3 });
		const text = textOf(result.content);
		expect(text).toContain("    10\trow10");
		expect(text).toContain("    12\trow12");
		expect(text).not.toContain("row13");
	});

	it("returns image content for image files", async () => {
		await writeFile(join(dir, "pixel.png"), Buffer.from(PNG_1x1_BASE64, "base64"));
		const tool = createReadTool(env);
		const result = await tool.execute("call-img", { file_path: "pixel.png" });
		expect(result.content).toHaveLength(1);
		expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect((result.content[0] as { data: string }).data).toBe(PNG_1x1_BASE64);
		expect(result.details.media).toBe("image");
	});

	it("marks the file as read in the access tracker", async () => {
		await writeFile(join(dir, "tracked.txt"), "one\ntwo\n");
		const tracker = createFileAccessTracker();
		const tool = createReadTool(env, tracker);
		await tool.execute("call-track", { file_path: "tracked.txt" });
		const info = await stat(join(dir, "tracked.txt"));
		expect(tracker.hasReadUpToDate(join(dir, "tracked.txt"), info.mtimeMs)).toBe(true);
	});
});
