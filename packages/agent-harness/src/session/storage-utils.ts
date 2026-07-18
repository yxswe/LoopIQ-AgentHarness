import type { FileError } from "../base/env.ts";
import type { SessionMetadata, SessionStorage } from "../base/session-types.ts";
import { type Result, SessionError } from "../base/types.ts";
import { Session } from "./session.ts";

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}
