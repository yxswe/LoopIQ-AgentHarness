import { describe, expect, it, vi } from "vitest";
import { isWithinUtf8Limit, PROTOCOL_LIMITS, parseRpcMessage } from "./index.ts";

describe("protocol byte limits", () => {
	it("fixes shared byte and timeout defaults", () => {
		expect(PROTOCOL_LIMITS).toEqual({
			inputBytes: 65_536,
			jsonMessageBytes: 33_554_432,
			snapshotBytes: 16_777_216,
			resultBytes: 16_777_216,
			rpcTimeoutMs: 30_000,
		});
	});

	it.each(["inputBytes", "jsonMessageBytes", "snapshotBytes", "resultBytes"] as const)(
		"checks multibyte payloads one byte below, at and above %s",
		(kind) => {
			const limit = PROTOCOL_LIMITS[kind];
			const prefix = kind === "inputBytes" ? "" : '{"jsonrpc":"2.0","id":"r1","result":{"text":"';
			const suffix = kind === "inputBytes" ? "" : '"}}';
			for (const delta of [-1, 0, 1]) {
				const contentBytes = limit + delta - prefix.length - suffix.length;
				const text = `${prefix}${"界".repeat(Math.floor(contentBytes / 3))}${"x".repeat(contentBytes % 3)}${suffix}`;
				expect(isWithinUtf8Limit(text, limit)).toBe(delta <= 0);
				if (kind === "jsonMessageBytes") {
					expect(parseRpcMessage(text).kind).toBe(delta <= 0 ? "success" : "tooLarge");
				}
			}
		},
	);

	it.each([
		["", 0],
		["a", 1],
		["é", 2],
		["界", 3],
		["🌍", 4],
		["\uD800", 3],
		["\uDC00", 3],
	])("counts UTF-8 bytes for %j, including unmatched surrogates", (text, bytes) => {
		expect(isWithinUtf8Limit(text, bytes)).toBe(true);
		expect(isWithinUtf8Limit(text, bytes - 1)).toBe(false);
	});

	it("counts JSON escaping and envelope overhead for serialized responses", () => {
		const text = "\u0000".repeat(Math.floor(PROTOCOL_LIMITS.snapshotBytes / 6));
		const encoded = JSON.stringify({ jsonrpc: "2.0", id: "r1", result: { text } });
		expect(isWithinUtf8Limit(text, PROTOCOL_LIMITS.snapshotBytes)).toBe(true);
		expect(isWithinUtf8Limit(encoded, PROTOCOL_LIMITS.snapshotBytes)).toBe(false);
	});

	it("rejects oversized malformed text before invoking JSON.parse", () => {
		const text = "界".repeat(Math.ceil(PROTOCOL_LIMITS.jsonMessageBytes / 3));
		const parse = vi.spyOn(JSON, "parse");
		try {
			expect(parseRpcMessage(text)).toEqual({ kind: "tooLarge" });
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});
});
