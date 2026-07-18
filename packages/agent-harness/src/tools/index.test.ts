import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "../base/resource.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createDefaultTools } from "./index.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

function byName(tools: AgentTool[], name: string): AgentTool {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`Tool not found: ${name}`);
	return tool;
}

describe("createDefaultTools", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "default-tools-"));
		env = new NodeExecutionEnv({ cwd: dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("exposes the seven built-in tools by name", () => {
		const names = createDefaultTools(env)
			.map((t) => t.name)
			.sort();
		expect(names).toEqual(["Bash", "Edit", "Glob", "Grep", "ListDir", "Read", "Write"]);
	});

	it("supports a write/read/edit/search/list/exec round trip", async () => {
		const tools = createDefaultTools(env);

		await byName(tools, "Write").execute("c1", { file_path: "notes.txt", content: "alpha\nbeta\n" });

		const read = await byName(tools, "Read").execute("c2", { file_path: "notes.txt" });
		expect(textOf(read.content)).toContain("alpha");

		await byName(tools, "Edit").execute("c3", { file_path: "notes.txt", old_string: "beta", new_string: "gamma" });

		const grep = await byName(tools, "Grep").execute("c4", { pattern: "gamma", output_mode: "content" });
		expect(textOf(grep.content)).toContain("notes.txt:2:gamma");

		const glob = await byName(tools, "Glob").execute("c5", { pattern: "**/*.txt" });
		expect(textOf(glob.content)).toContain("notes.txt");

		const list = await byName(tools, "ListDir").execute("c6", {});
		expect(textOf(list.content)).toContain("notes.txt");

		const bash = await byName(tools, "Bash").execute("c7", { command: "echo hi" });
		expect(textOf(bash.content)).toContain("hi");
	});
});
