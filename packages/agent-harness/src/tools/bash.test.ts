import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { createBashTool } from "./bash.ts";

function textOf(content: { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

describe("Bash tool", () => {
	let dir: string;
	let env: NodeExecutionEnv;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bash-tool-"));
		env = new NodeExecutionEnv({ cwd: dir });
	});

	afterEach(async () => {
		await env.cleanup();
		await rm(dir, { recursive: true, force: true });
	});

	it("runs a command and returns stdout with exit code 0", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "echo hello-world" });
		expect(textOf(result.content)).toContain("hello-world");
		expect(result.details.exitCode).toBe(0);
		expect(result.details.cancelled).toBe(false);
	});

	it("reports a non-zero exit code", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "echo out; exit 7" });
		expect(textOf(result.content)).toContain("out");
		expect(result.details.exitCode).toBe(7);
	});

	it("truncates very large output", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "for i in $(seq 1 5000); do echo line$i; done" });
		expect(result.details.truncated).toBe(true);
	});

	it("cancels when the abort signal fires", async () => {
		const tool = createBashTool(env);
		const controller = new AbortController();
		const promise = tool.execute("call-1", { command: "sleep 5" }, controller.signal);
		controller.abort();
		const result = await promise;
		expect(result.details.cancelled).toBe(true);
	});

	it("separates stderr into a STDERR section", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "echo out; echo oops 1>&2" });
		const text = textOf(result.content);
		expect(text).toContain("out");
		expect(text).toContain("STDERR:");
		expect(text).toContain("oops");
		expect(result.details.exitCode).toBe(0);
	});

	it("passes the description through to details", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "echo hi", description: "say hi" });
		expect(result.details.description).toBe("say hi");
	});

	it("runs a command in the background and writes output to a log file", async () => {
		const tool = createBashTool(env);
		const result = await tool.execute("call-1", { command: "echo bg-hello", run_in_background: true });
		expect(result.details.background).toBe(true);
		expect(result.details.backgroundId).toBeDefined();
		const logPath = result.details.logPath;
		expect(logPath).toBeDefined();

		let contents = "";
		for (let i = 0; i < 50; i++) {
			const read = await env.readTextFile(logPath as string);
			if (read.ok && read.value.includes("bg-hello")) {
				contents = read.value;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(contents).toContain("bg-hello");
	});
});
