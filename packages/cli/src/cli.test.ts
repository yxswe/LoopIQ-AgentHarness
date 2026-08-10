import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "./cli.ts";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const executable = resolve(repositoryRoot, "node_modules/.bin/loopiq");

function runExecutable(
	args: string[],
	options?: { input?: string; inputAfter?: { marker: string; text: string }; env?: NodeJS.ProcessEnv },
) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
		const child = spawn(executable, args, {
			cwd: repositoryRoot,
			env: { ...process.env, ...options?.env },
			stdio: "pipe",
		});
		let stdout = "";
		let stderr = "";
		let sentDelayedInput = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (!sentDelayedInput && options?.inputAfter && stderr.includes(options.inputAfter.marker)) {
				sentDelayedInput = true;
				child.stdin.end(options.inputAfter.text);
			}
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
		if (!options?.inputAfter) child.stdin.end(options?.input);
	});
}

describe("CLI argument parsing", () => {
	it("uses explicit commands and shows help when no command is supplied", () => {
		expect(parseArgs([]).command).toBe("help");
		expect(() => parseArgs(["unknown-command"])).toThrow(CliUsageError);
	});

	it("parses a one-shot run and supports prompt option delimiters", () => {
		expect(parseArgs(["run", "hello", "world", "--format", "json"])).toMatchObject({
			command: "run",
			prompt: "hello world",
			format: "json",
		});
		expect(parseArgs(["run", "--", "--explain", "this"])).toMatchObject({
			prompt: "--explain this",
		});
	});

	it("requires exactly one run input source", () => {
		expect(() => parseArgs(["run"])).toThrow(/exactly one/);
		expect(() => parseArgs(["run", "hello", "--stdin"])).toThrow(/exactly one/);
		expect(parseArgs(["run", "--stdin"]).stdin).toBe(true);
	});

	it("keeps new and resumed Session configuration unambiguous", () => {
		expect(parseArgs(["chat", "hello", "--continue"])).toMatchObject({
			command: "chat",
			prompt: "hello",
			continueSession: true,
		});
		expect(() => parseArgs(["run", "hello", "--session", "a", "--workspace", "."])).toThrow(/--workspace/);
		expect(() => parseArgs(["chat", "--continue", "--model", "openai/gpt-4.1"])).toThrow(/new Session/);
	});

	it("gives every accepted Provider request option its configuration owner", () => {
		expect(() => parseArgs(["run", "hello", "--timeout-ms", "1"])).toThrow(/not valid/);
		expect(
			parseArgs([
				"config",
				"set-provider-request",
				"--transport",
				"sse",
				"--timeout-ms",
				"120000",
				"--max-retries",
				"0",
				"--max-retry-delay-ms",
				"60000",
				"--cache-retention",
				"short",
			]),
		).toMatchObject({
			command: "config-set-provider-request",
			providerRequest: {
				transport: "sse",
				timeoutMs: 120_000,
				maxRetries: 0,
				maxRetryDelayMs: 60_000,
				cacheRetention: "short",
			},
		});
	});

	it("supports explicit local and non-interactive Provider operations", () => {
		expect(parseArgs(["providers", "validate", "openai"])).toMatchObject({
			command: "providers-validate",
			target: "openai",
		});
		expect(parseArgs(["providers", "add", "openai", "--token-stdin"])).toMatchObject({
			command: "providers-add",
			authMethod: "api_token",
			tokenStdin: true,
		});
		expect(() =>
			parseArgs(["providers", "add", "github-copilot", "--auth-method", "oauth", "--token-stdin"]),
		).toThrow(/OAuth/);
	});

	it("rejects options and arguments that a command does not own", () => {
		expect(() => parseArgs(["sessions", "create", "--session", "existing"])).toThrow(/not valid/);
		expect(() => parseArgs(["sessions", "list", "extra"])).toThrow(/Unexpected argument/);
		expect(() => parseArgs(["--format", "json", "sessions", "list"])).toThrow(/Unknown command/);
	});
});

describe("CLI executable", () => {
	it("runs through the npm bin symlink and exposes help", async () => {
		const result = await execFileAsync(executable, ["--help"], { cwd: repositoryRoot });
		expect(result.stdout).toContain("LoopIQ Agent CLI");
		expect(result.stderr).toBe("");
	});

	it("reports machine-readable build and event-schema identity", async () => {
		const result = await execFileAsync(executable, ["--version", "--format", "json"], { cwd: repositoryRoot });
		expect(JSON.parse(result.stdout)).toMatchObject({
			name: "loopiq",
			version: "0.1.0",
			eventSchema: { name: "loopiq.cli.event", version: 1 },
		});
	});

	it("emits an ordered machine terminal for an accepted failed Run", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "loopiq-cli-test-"));
		try {
			const result = await runExecutable(["run", "hello", "--format", "jsonl", "--workspace", repositoryRoot], {
				env: { HOME: home },
			});
			const events = result.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(result.code).toBe(1);
			expect(result.stderr).toBe("");
			expect(events[0]).toMatchObject({ schema: "loopiq.cli.event", schemaVersion: 1, type: "run_started" });
			expect(events.at(-1)).toMatchObject({ type: "run_completed", status: "failed" });
			expect(events.filter((event) => event.type === "run_completed")).toHaveLength(1);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("serializes an asynchronous command failure instead of leaking a rejected Promise", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "loopiq-cli-test-"));
		try {
			const result = await runExecutable(["providers", "validate", "not-a-provider", "--format", "json"], {
				env: { HOME: home },
			});
			expect(result.code).toBe(3);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toMatchObject({ type: "command_failed", phase: "setup_or_execution" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("prints an actionable text error instead of a blank response", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "loopiq-cli-test-"));
		try {
			const result = await runExecutable(["run", "hello", "--workspace", repositoryRoot], { env: { HOME: home } });
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("No API key for provider");
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("does not create an empty Session when chat exits before the first message", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "loopiq-cli-test-"));
		try {
			const result = await runExecutable(["chat", "--workspace", repositoryRoot], {
				env: { HOME: home },
				input: "/exit\n",
			});
			expect(result.code).toBe(0);
			const sessions = await runExecutable(["sessions", "list", "--format", "json"], { env: { HOME: home } });
			expect(JSON.parse(sessions.stdout)).toEqual([]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("makes /new leave a resumed Session and create a fresh one", async () => {
		const home = await mkdtemp(resolve(tmpdir(), "loopiq-cli-test-"));
		try {
			const created = await runExecutable(
				["sessions", "create", "--workspace", repositoryRoot, "--format", "json"],
				{ env: { HOME: home } },
			);
			const original = JSON.parse(created.stdout) as { id: string };
			const chat = await runExecutable(["chat", "/new", "--session", original.id], {
				env: { HOME: home },
				inputAfter: { marker: "A new Session", text: "hello\n" },
			});
			expect(chat.code).toBe(1);

			const listed = await runExecutable(["sessions", "list", "--format", "json"], { env: { HOME: home } });
			const sessions = JSON.parse(listed.stdout) as { id: string }[];
			expect(sessions).toHaveLength(2);
			expect(sessions.some((session) => session.id !== original.id)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
