export const PROTOCOL_LIMITS = {
	inputBytes: 64 * 1024,
	jsonMessageBytes: 32 * 1024 * 1024,
	snapshotBytes: 16 * 1024 * 1024,
	resultBytes: 16 * 1024 * 1024,
	rpcTimeoutMs: 30_000,
} as const;

const encoder = new TextEncoder();

/** Pass raw input text or already-encoded JSON, according to the selected bound. */
export function isWithinUtf8Limit(text: string, maxBytes: number): boolean {
	// UTF-16 length is a lower bound; avoid encoding obviously oversized strings.
	return text.length <= maxBytes && encoder.encode(text).byteLength <= maxBytes;
}
