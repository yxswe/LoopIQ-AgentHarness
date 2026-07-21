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
		expect(parseArgs(["sessions", "delete", "session-id"]).deleteSessionId).toBe("session-id");
		expect(parseArgs(["sessions", "list", "--format", "json"]).command).toBe("sessions-list");
	});
});
