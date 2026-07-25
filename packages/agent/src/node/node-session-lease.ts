import type { FileHandle } from "node:fs/promises";
import { open, rm } from "node:fs/promises";
import { AgentRuntimeError, toError } from "../base/types.ts";

export interface NodeSessionLease {
	release(): Promise<void>;
}

export async function acquireNodeSessionLease(lockPath: string): Promise<NodeSessionLease> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(lockPath, "wx");
		await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
	} catch (error) {
		if (handle) {
			await handle.close().catch(() => undefined);
			await rm(lockPath, { force: true }).catch(() => undefined);
		}
		const cause = toError(error);
		if ("code" in cause && cause.code === "EEXIST") {
			throw new AgentRuntimeError("session_locked", `Session is locked by another runtime: ${lockPath}`, cause);
		}
		throw new AgentRuntimeError("session", `Failed to acquire Session writer lease: ${lockPath}`, cause);
	}

	let released = false;
	const acquiredHandle = handle;
	if (!acquiredHandle) throw new AgentRuntimeError("session", `Failed to acquire Session writer lease: ${lockPath}`);
	return {
		async release() {
			if (released) return;
			released = true;
			try {
				await acquiredHandle.close();
			} finally {
				await rm(lockPath, { force: true });
			}
		},
	};
}
