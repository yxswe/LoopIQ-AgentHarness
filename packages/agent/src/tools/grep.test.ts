import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createGrepTool, globToRegExp } from "./grep.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("Grep tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "grep-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
		await writeFile(join(dir, "a.txt"), "foo\nbar\nfoobar\n");
		await writeFile(join(dir, "b.md"), "nothing here\nfoo again\n");
		await mkdir(join(dir, "sub"));
		await writeFile(join(dir, "sub", "c.txt"), "deep foo\n");
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("globToRegExp matches * and ? on basenames", () => {
		expect(globToRegExp("*.ts").test("index.ts")).toBe(true);
		expect(globToRegExp("*.ts").test("index.js")).toBe(false);
		expect(globToRegExp("a?.txt").test("ab.txt")).toBe(true);
	});

	it("content mode returns path:line:text for matches", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "content" });
		const text = textOf(result.content);
		expect(text).toContain("a.txt:1:foo");
		expect(text).toContain("a.txt:3:foobar");
		expect(result.details.matchingLines).toBe(4); // a.txt x2, b.md x1, sub/c.txt x1
	});

	it("files_with_matches returns unique file paths", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "files_with_matches" });
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).toContain("b.md");
		expect(text).toContain(join("sub", "c.txt"));
		expect(result.details.matchingFiles).toBe(3);
	});

	it("count mode returns per-file counts", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "count" });
		const text = textOf(result.content);
		expect(text).toMatch(/a\.txt:2/);
	});

	it("returns no matches cleanly", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "zzz-none", output_mode: "content" });
		expect(result.details.matchingLines).toBe(0);
		expect(result.details.matchingFiles).toBe(0);
	});

	it("filters files by glob", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "files_with_matches", glob: "*.md" });
		const text = textOf(result.content);
		expect(text).toContain("b.md");
		expect(text).not.toContain("a.txt");
		expect(result.details.matchingFiles).toBe(1);
	});

	it("honors head_limit", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "content", head_limit: 1 });
		expect(textOf(result.content).split("\n").filter(Boolean)).toHaveLength(1);
		expect(result.details.truncated).toBe(true);
	});

	it("emits before/after context lines in content mode", async () => {
		await writeFile(join(dir, "ctx.txt"), "l1\nl2\nMATCH\nl4\nl5\n");
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", {
			pattern: "MATCH",
			path: "ctx.txt",
			output_mode: "content",
			before_context: 1,
			after_context: 1,
		});
		const text = textOf(result.content);
		expect(text).toContain("ctx.txt-2-l2");
		expect(text).toContain("ctx.txt:3:MATCH");
		expect(text).toContain("ctx.txt-4-l4");
		expect(text).not.toContain("l1");
		expect(text).not.toContain("l5");
	});

	it("context (-C) sets both before and after", async () => {
		await writeFile(join(dir, "ctx.txt"), "l1\nl2\nMATCH\nl4\nl5\n");
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", {
			pattern: "MATCH",
			path: "ctx.txt",
			output_mode: "content",
			context: 1,
		});
		const text = textOf(result.content);
		expect(text).toContain("ctx.txt-2-l2");
		expect(text).toContain("ctx.txt-4-l4");
	});

	it("filters files by language type", async () => {
		await writeFile(join(dir, "x.ts"), "TODO alpha\n");
		await writeFile(join(dir, "x.js"), "TODO beta\n");
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "TODO", output_mode: "files_with_matches", type: "ts" });
		const text = textOf(result.content);
		expect(text).toContain("x.ts");
		expect(text).not.toContain("x.js");
	});

	it("matches across lines with multiline", async () => {
		await writeFile(join(dir, "ml.txt"), "start\nmid\nend\n");
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", {
			pattern: "start[\\s\\S]*end",
			path: "ml.txt",
			output_mode: "content",
			multiline: true,
		});
		expect(result.details.matchingLines).toBe(1);
		expect(textOf(result.content)).toContain("ml.txt:1:start");
	});

	it("skips leading results with offset", async () => {
		const tool = createGrepTool(env);
		const result = await tool.execute("c1", { pattern: "foo", output_mode: "content", offset: 2 });
		const text = textOf(result.content);
		expect(text).not.toContain("a.txt:1:foo");
		expect(text).toContain("b.md:2:foo again");
	});
});
