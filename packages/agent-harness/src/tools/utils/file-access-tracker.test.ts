import { describe, expect, it } from "vitest";
import { createFileAccessTracker } from "./file-access-tracker.ts";

describe("FileAccessTracker", () => {
	it("reports not read for unknown paths", () => {
		const tracker = createFileAccessTracker();
		expect(tracker.hasReadUpToDate("/a.txt", 100)).toBe(false);
	});

	it("reports read up-to-date when mtime is unchanged since read", () => {
		const tracker = createFileAccessTracker();
		tracker.markRead("/a.txt", 100);
		expect(tracker.hasReadUpToDate("/a.txt", 100)).toBe(true);
	});

	it("reports stale when the file changed after read", () => {
		const tracker = createFileAccessTracker();
		tracker.markRead("/a.txt", 100);
		expect(tracker.hasReadUpToDate("/a.txt", 200)).toBe(false);
	});

	it("treats a write as an up-to-date read", () => {
		const tracker = createFileAccessTracker();
		tracker.markWritten("/a.txt", 300);
		expect(tracker.hasReadUpToDate("/a.txt", 300)).toBe(true);
	});

	it("keeps entries independent per path", () => {
		const tracker = createFileAccessTracker();
		tracker.markRead("/a.txt", 100);
		expect(tracker.hasReadUpToDate("/b.txt", 100)).toBe(false);
	});
});
