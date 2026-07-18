import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createGlobTool, expandBraces, globToPathRegExp } from "./glob.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("Glob tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "glob-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
		await writeFile(join(dir, "a.txt"), "a");
		await writeFile(join(dir, "b.txt"), "b");
		await writeFile(join(dir, "c.log"), "c");
		await mkdir(join(dir, "sub"));
		await writeFile(join(dir, "sub", "d.txt"), "d");
		// a.txt older, b.txt newer -> b should sort first by mtime desc.
		await utimes(join(dir, "a.txt"), new Date(1000), new Date(1000));
		await utimes(join(dir, "b.txt"), new Date(2000), new Date(2000));
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("globToPathRegExp handles ** and * segment boundaries", () => {
		expect(globToPathRegExp("**/*.ts").test("x.ts")).toBe(true);
		expect(globToPathRegExp("**/*.ts").test("a/b/x.ts")).toBe(true);
		expect(globToPathRegExp("*.ts").test("x.ts")).toBe(true);
		expect(globToPathRegExp("*.ts").test("a/x.ts")).toBe(false);
	});

	it("finds files recursively by pattern", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "**/*.txt" });
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).toContain("b.txt");
		expect(text).toContain(join("sub", "d.txt"));
		expect(text).not.toContain("c.log");
		expect(result.details.matches).toBe(3);
	});

	it("sorts results by modification time descending", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "*.txt" });
		const lines = textOf(result.content).split("\n").filter(Boolean);
		expect(lines[0]).toContain("b.txt");
		expect(lines[1]).toContain("a.txt");
	});

	it("returns no matches cleanly", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "*.nomatch" });
		expect(result.details.matches).toBe(0);
	});

	it("honors the limit", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "**/*.txt", limit: 1 });
		expect(textOf(result.content).split("\n").filter(Boolean)).toHaveLength(1);
		expect(result.details.truncated).toBe(true);
	});

	it("expandBraces produces the cartesian product of options", () => {
		expect(expandBraces("*.ts")).toEqual(["*.ts"]);
		expect(expandBraces("*.{ts,js}")).toEqual(["*.ts", "*.js"]);
		expect(expandBraces("{a,b}.{ts,js}")).toEqual(["a.ts", "a.js", "b.ts", "b.js"]);
	});

	it("matches multiple extensions via brace expansion", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "*.{txt,log}" });
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).toContain("c.log");
		expect(result.details.matches).toBe(3);
	});

	it("limits recursion with max_depth", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "**/*.txt", max_depth: 1 });
		const text = textOf(result.content);
		expect(text).toContain("a.txt");
		expect(text).not.toContain(join("sub", "d.txt"));
		expect(result.details.matches).toBe(2);
	});

	it("outputs absolute paths when requested", async () => {
		const tool = createGlobTool(env);
		const result = await tool.execute("c1", { pattern: "*.txt", absolute: true });
		const text = textOf(result.content);
		expect(text).toContain(join(dir, "a.txt"));
	});
});
