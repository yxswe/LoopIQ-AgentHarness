import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentRuntimeError, toError } from "../base/types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 25;
const OWNER_WRITE_GRACE_MS = 2_000;

interface LockOwner {
	pid: number;
	acquiredAt: string;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		const value = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as Partial<LockOwner>;
		return typeof value.pid === "number" && typeof value.acquiredAt === "string"
			? { pid: value.pid, acquiredAt: value.acquiredAt }
			: undefined;
	} catch {
		return undefined;
	}
}

async function recoverStaleLock(lockPath: string): Promise<boolean> {
	const owner = await readOwner(lockPath);
	if (owner) {
		if (isProcessAlive(owner.pid)) return false;
		await rm(lockPath, { recursive: true, force: true });
		return true;
	}

	try {
		const lockStat = await stat(lockPath);
		if (Date.now() - lockStat.mtimeMs < OWNER_WRITE_GRACE_MS) return false;
		await rm(lockPath, { recursive: true, force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

export async function withFileLock<T>(
	lockPath: string,
	task: () => Promise<T>,
	options?: { timeoutMs?: number },
): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	await mkdir(dirname(lockPath), { recursive: true });
	while (true) {
		try {
			await mkdir(lockPath);
		} catch (error) {
			const cause = toError(error);
			if (!("code" in cause) || cause.code !== "EEXIST") {
				throw new AgentRuntimeError("credential_store", `Failed to use file lock ${lockPath}`, cause);
			}
			if (await recoverStaleLock(lockPath)) continue;
			if (Date.now() >= deadline) {
				throw new AgentRuntimeError("credential_store", `Timed out waiting for file lock ${lockPath}`, cause);
			}
			await delay(RETRY_DELAY_MS);
			continue;
		}

		try {
			await writeFile(
				join(lockPath, "owner.json"),
				`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
				{ mode: 0o600 },
			);
			return await task();
		} finally {
			await rm(lockPath, { recursive: true, force: true });
		}
	}
}
