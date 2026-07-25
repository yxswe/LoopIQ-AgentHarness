/**
 * In-memory tracker of file read/write access, shared across the Read, Write,
 * and Edit tools within a single tool set.
 *
 * It records the last modification time observed when a file was read or
 * written, so that Write/Edit can require a fresh Read before mutating an
 * existing file and detect when a file changed externally since it was read.
 */
export interface FileAccessTracker {
	/** Record that `absPath` was read while its modification time was `mtimeMs`. */
	markRead(absPath: string, mtimeMs: number): void;
	/** Record that `absPath` was written, producing modification time `mtimeMs`. */
	markWritten(absPath: string, mtimeMs: number): void;
	/**
	 * Return true when `absPath` was previously read or written and has not
	 * changed since (its current `mtimeMs` matches the recorded one).
	 */
	hasReadUpToDate(absPath: string, mtimeMs: number): boolean;
}

/** Create an empty {@link FileAccessTracker}. */
export function createFileAccessTracker(): FileAccessTracker {
	const seen = new Map<string, number>();
	return {
		markRead(absPath, mtimeMs) {
			seen.set(absPath, mtimeMs);
		},
		markWritten(absPath, mtimeMs) {
			seen.set(absPath, mtimeMs);
		},
		hasReadUpToDate(absPath, mtimeMs) {
			const recorded = seen.get(absPath);
			return recorded !== undefined && recorded === mtimeMs;
		},
	};
}
