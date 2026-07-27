import { describe, expect, it } from "vitest";
import { parseArgs } from "./cli.ts";

describe("CLI argument parsing", () => {
	it("parses a one-shot run", () => {
		const options = parseArgs(["run", "hello", "world", "--new", "--format", "json"]);
		expect(options.command).toBe("run");
		expect(options.prompt).toBe("hello world");
		expect(options.newSession).toBe(true);
		expect(options.format).toBe("json");
	});

	it("rejects ambiguous input and Session selection", () => {
		expect(() => parseArgs(["run", "hello", "--stdin"])).toThrow(/mutually exclusive/);
		expect(() => parseArgs(["run", "--session", "a", "--new"])).toThrow(/mutually exclusive/);
	});

	it("parses Session management commands", () => {
		expect(parseArgs(["sessions", "delete", "session-id"]).target).toBe("session-id");
		expect(parseArgs(["sessions", "list", "--format", "json"]).command).toBe("sessions-list");
		expect(parseArgs(["sessions", "create", "--workspace", "."]).workspaceDir).toBe(process.cwd());
	});

	it("parses provider and configuration commands", () => {
		expect(parseArgs(["providers", "add", "anthropic", "--auth-method", "oauth"])).toMatchObject({
			command: "providers-add",
			target: "anthropic",
			authMethod: "oauth",
		});
		expect(parseArgs(["config", "set-model", "openai/gpt-4.1"]).target).toBe("openai/gpt-4.1");
		expect(parseArgs(["config", "set-thinking", "high"])).toMatchObject({
			command: "config-set-thinking",
			target: "high",
		});
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
});
