// Node.js public barrel for @loopiq/agent-core.
//
// Re-exports the platform-agnostic surface and adds the node initialization
// entry point `createNodeHarness`, which assembles the node-only execution
// environment and JSONL session storage internally so callers never touch
// NodeExecutionEnv / JsonlSessionStorage / Session directly.

import { randomUUID } from "node:crypto";
import type { AgentHarnessOptions } from "./base/options.ts";
import { AgentHarness } from "./core/agent-harness.ts";
import { NodeExecutionEnv } from "./env/nodejs.ts";
import { JsonlSessionStorage } from "./session/jsonl-storage.ts";
import { toSession } from "./session/repo-utils.ts";

export * from "./index.ts";

/**
 * Options for {@link createNodeHarness}. Everything the harness needs except the
 * node-only `env` and `session`, which the factory assembles from `cwd` and
 * `sessionPath`.
 */
export type NodeHarnessOptions = Omit<AgentHarnessOptions, "env" | "session"> & {
	/** Working directory for the node execution environment. */
	cwd: string;
	/** Path to the JSONL session file. Opened if it exists, created otherwise. */
	sessionPath: string;
};

/**
 * Create an {@link AgentHarness} wired to a node execution environment and a
 * JSONL-backed session. The session file at `sessionPath` is opened if present,
 * otherwise created.
 */
export async function createNodeHarness(options: NodeHarnessOptions): Promise<AgentHarness> {
	const { cwd, sessionPath, ...rest } = options;
	const env = new NodeExecutionEnv({ cwd });
	const storage = await openOrCreateSessionStorage(env, sessionPath, cwd);
	const session = toSession(storage);
	return new AgentHarness({ env, session, ...rest });
}

async function openOrCreateSessionStorage(
	env: NodeExecutionEnv,
	sessionPath: string,
	cwd: string,
): Promise<JsonlSessionStorage> {
	const existing = await env.readTextFile(sessionPath);
	if (existing.ok) {
		return JsonlSessionStorage.open(env, sessionPath);
	}
	return JsonlSessionStorage.create(env, sessionPath, { cwd, sessionId: randomUUID() });
}
