import { type ImageContent, type Static, type TextContent, Type } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import type { FileAccessTracker } from "./utils/file-access-tracker.ts";
import { DEFAULT_MAX_LINES, truncateHead } from "./utils/truncate.ts";

export const readToolSchema = Type.Object({
	file_path: Type.String({ description: "Absolute or cwd-relative path to the file to read." }),
	offset: Type.Optional(Type.Number({ description: "1-based line number to start reading from." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read. Defaults to 2000." })),
});

export type ReadToolParams = Static<typeof readToolSchema>;

export interface ReadToolDetails {
	/** Absolute path that was read. */
	path: string;
	/** Media kind of the returned content. */
	media: "text" | "image";
	/** Total number of lines in the file. Zero for images. */
	totalLines: number;
	/** Number of lines included in the returned output. Zero for images. */
	returnedLines: number;
	/** 1-based line number the output starts at. */
	offset: number;
	/** Whether the output was truncated to fit size or line limits. */
	truncated: boolean;
}

/** Hard cap on the byte size of a file read without an explicit line limit. */
export const READ_MAX_BYTES = 256 * 1024;

/** Image file extensions returned as base64 {@link ImageContent}. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

function extensionOf(path: string): string {
	const base = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function toBase64(bytes: Uint8Array): string {
	const runtimeBuffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } })
		.Buffer;
	if (runtimeBuffer) return runtimeBuffer.from(bytes).toString("base64");
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/** Format lines with right-aligned 1-based line numbers, tab-separated (cat -n style). */
export function formatNumberedLines(lines: string[], startLine: number): string {
	return lines.map((line, i) => `${String(startLine + i).padStart(6, " ")}\t${line}`).join("\n");
}

/** Create the Read tool bound to an execution environment. */
export function createReadTool(
	env: ExecutionEnv,
	tracker?: FileAccessTracker,
): AgentTool<typeof readToolSchema, ReadToolDetails> {
	return {
		name: "Read",
		label: "Read",
		description:
			"Read a file from the filesystem. Text files return numbered lines (default first 2000); image files return image content.",
		parameters: readToolSchema,
		async execute(_toolCallId, params, signal) {
			const absResult = await env.absolutePath(params.file_path, signal);
			const path = absResult.ok ? absResult.value : params.file_path;

			const infoResult = await env.fileInfo(params.file_path, signal);
			if (!infoResult.ok) {
				throw new Error(`Failed to read ${params.file_path}: ${infoResult.error.message}`);
			}
			const info = infoResult.value;

			const ext = extensionOf(params.file_path);
			const imageMime = IMAGE_MIME_BY_EXT[ext];
			if (imageMime) {
				const binResult = await env.readBinaryFile(params.file_path, signal);
				if (!binResult.ok) {
					throw new Error(`Failed to read ${params.file_path}: ${binResult.error.message}`);
				}
				const image: ImageContent = { type: "image", data: toBase64(binResult.value), mimeType: imageMime };
				return {
					content: [image],
					details: { path, media: "image", totalLines: 0, returnedLines: 0, offset: 1, truncated: false },
				};
			}

			if (params.limit === undefined && info.size > READ_MAX_BYTES) {
				throw new Error(
					`File ${params.file_path} is ${info.size} bytes, exceeding the ${READ_MAX_BYTES}-byte read cap. ` +
						"Provide `offset` and `limit` to read a slice, or use Grep/Bash to inspect it.",
				);
			}

			const readResult = await env.readTextFile(params.file_path, signal);
			if (!readResult.ok) {
				throw new Error(`Failed to read ${params.file_path}: ${readResult.error.message}`);
			}

			const rawLines = readResult.value.split("\n");
			const lines =
				rawLines.length > 1 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
			const totalLines = lines.length;

			const offset = params.offset && params.offset > 0 ? params.offset : 1;
			const start = offset - 1;
			const limit = params.limit !== undefined ? params.limit : DEFAULT_MAX_LINES;
			const end = start + limit;
			const selected = lines.slice(start, end);
			const lineLimited = end < totalLines;

			const truncation = truncateHead(formatNumberedLines(selected, offset));

			tracker?.markRead(path, info.mtimeMs);

			const text: TextContent = { type: "text", text: truncation.content };
			return {
				content: [text],
				details: {
					path,
					media: "text",
					totalLines,
					returnedLines: truncation.truncated ? truncation.outputLines : selected.length,
					offset,
					truncated: truncation.truncated || lineLimited,
				},
			};
		},
	};
}
