import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import type { FileAccessTracker } from "./utils/file-access-tracker.ts";

const editOperationSchema = Type.Object({
	old_string: Type.String({ description: "Exact text to replace. Must be unique unless replace_all is true." }),
	new_string: Type.String({ description: "Replacement text." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness." })),
});

export const editToolSchema = Type.Object({
	file_path: Type.String({ description: "Absolute or cwd-relative path to the file to edit." }),
	old_string: Type.Optional(Type.String({ description: "Exact text to replace. Must be unique unless replace_all is true." })),
	new_string: Type.Optional(Type.String({ description: "Replacement text." })),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring uniqueness." })),
	edits: Type.Optional(
		Type.Array(editOperationSchema, {
			description: "Multiple edits applied sequentially in order. Overrides old_string/new_string when provided.",
		}),
	),
});

export type EditToolParams = Static<typeof editToolSchema>;

interface EditOperation {
	old_string: string;
	new_string: string;
	replace_all?: boolean;
}

export interface EditToolDetails {
	/** Absolute path that was edited. */
	path: string;
	/** Total number of occurrences replaced across all edits. */
	replacements: number;
	/** Number of edit operations applied. */
	edits: number;
}

/** Count non-overlapping occurrences of needle in haystack. */
export function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Apply one edit to `content`, throwing on missing or non-unique matches. Returns the new content and replacement count. */
function applyOne(content: string, op: EditOperation, path: string): { content: string; replacements: number } {
	if (op.old_string === "") {
		throw new Error(`old_string must not be empty (${path})`);
	}
	const occurrences = countOccurrences(content, op.old_string);
	if (occurrences === 0) {
		throw new Error(`old_string not found in ${path}: ${JSON.stringify(op.old_string.slice(0, 40))}`);
	}
	const replaceAll = op.replace_all === true;
	if (occurrences > 1 && !replaceAll) {
		throw new Error(
			`old_string is not unique in ${path} (${occurrences} occurrences). Provide more context or set replace_all.`,
		);
	}
	const updated = replaceAll
		? content.split(op.old_string).join(op.new_string)
		: content.replace(op.old_string, op.new_string);
	return { content: updated, replacements: replaceAll ? occurrences : 1 };
}

/** Create the Edit tool bound to an execution environment. */
export function createEditTool(
	env: ExecutionEnv,
	tracker?: FileAccessTracker,
): AgentTool<typeof editToolSchema, EditToolDetails> {
	return {
		name: "Edit",
		label: "Edit",
		description:
			"Replace exact strings in a file. Pass a single old_string/new_string, or an edits array applied in order. Each match must be unique unless replace_all.",
		parameters: editToolSchema,
		async execute(_toolCallId, params, signal) {
			const absResult = await env.absolutePath(params.file_path, signal);
			const path = absResult.ok ? absResult.value : params.file_path;

			const operations: EditOperation[] =
				params.edits && params.edits.length > 0
					? params.edits
					: params.old_string !== undefined
						? [{ old_string: params.old_string, new_string: params.new_string ?? "", replace_all: params.replace_all }]
						: [];
			if (operations.length === 0) {
				throw new Error("Provide old_string/new_string or a non-empty edits array.");
			}

			// Require a fresh Read before editing an existing file. Enforced only
			// when a tracker is provided.
			if (tracker) {
				const infoResult = await env.fileInfo(params.file_path, signal);
				if (!infoResult.ok) {
					throw new Error(`Failed to read ${params.file_path}: ${infoResult.error.message}`);
				}
				if (!tracker.hasReadUpToDate(path, infoResult.value.mtimeMs)) {
					throw new Error(
						`Refusing to edit ${params.file_path}: read the file first (it may have changed since it was last read).`,
					);
				}
			}

			const readResult = await env.readTextFile(params.file_path, signal);
			if (!readResult.ok) {
				throw new Error(`Failed to read ${params.file_path}: ${readResult.error.message}`);
			}

			let content = readResult.value;
			let replacements = 0;
			for (const op of operations) {
				const applied = applyOne(content, op, params.file_path);
				content = applied.content;
				replacements += applied.replacements;
			}

			const writeResult = await env.writeFile(params.file_path, content, signal);
			if (!writeResult.ok) {
				throw new Error(`Failed to write ${params.file_path}: ${writeResult.error.message}`);
			}

			const postInfo = await env.fileInfo(params.file_path, signal);
			if (postInfo.ok) tracker?.markWritten(path, postInfo.value.mtimeMs);

			return {
				content: [
					{ type: "text", text: `Replaced ${replacements} occurrence(s) across ${operations.length} edit(s) in ${path}` },
				],
				details: { path, replacements, edits: operations.length },
			};
		},
	};
}
