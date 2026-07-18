import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import type { FileAccessTracker } from "./utils/file-access-tracker.ts";

export const writeToolSchema = Type.Object({
	file_path: Type.String({ description: "Absolute or cwd-relative path to write. Parent directories are created." }),
	content: Type.String({ description: "UTF-8 content to write. Overwrites the file unless append is true." }),
	append: Type.Optional(Type.Boolean({ description: "Append to the file instead of overwriting it." })),
});

export type WriteToolParams = Static<typeof writeToolSchema>;

export interface WriteToolDetails {
	/** Absolute path that was written. */
	path: string;
	/** Number of UTF-8 bytes written. */
	bytesWritten: number;
	/** True if the file did not exist before this write. */
	created: boolean;
	/** True when content was appended rather than overwriting. */
	appended: boolean;
}

/** Create the Write tool bound to an execution environment. */
export function createWriteTool(
	env: ExecutionEnv,
	tracker?: FileAccessTracker,
): AgentTool<typeof writeToolSchema, WriteToolDetails> {
	return {
		name: "Write",
		label: "Write",
		description: "Create, overwrite, or append to a UTF-8 text file. Creates parent directories as needed.",
		parameters: writeToolSchema,
		async execute(_toolCallId, params, signal) {
			const absResult = await env.absolutePath(params.file_path, signal);
			const path = absResult.ok ? absResult.value : params.file_path;
			const append = params.append === true;

			const existsResult = await env.exists(params.file_path, signal);
			if (!existsResult.ok) {
				throw new Error(`Failed to write ${params.file_path}: ${existsResult.error.message}`);
			}
			const created = !existsResult.value;

			// Require a fresh Read before overwriting an existing file, so the model
			// cannot blindly clobber content it has not seen. New files and appends
			// are exempt. The guard is only enforced when a tracker is provided.
			if (tracker && !created && !append) {
				const infoResult = await env.fileInfo(params.file_path, signal);
				if (!infoResult.ok) {
					throw new Error(`Failed to write ${params.file_path}: ${infoResult.error.message}`);
				}
				if (!tracker.hasReadUpToDate(path, infoResult.value.mtimeMs)) {
					throw new Error(
						`Refusing to overwrite ${params.file_path}: read the file first (it may have changed since it was last read).`,
					);
				}
			}

			const writeResult = append
				? await env.appendFile(params.file_path, params.content, signal)
				: await env.writeFile(params.file_path, params.content, signal);
			if (!writeResult.ok) {
				throw new Error(`Failed to write ${params.file_path}: ${writeResult.error.message}`);
			}

			const bytesWritten = new TextEncoder().encode(params.content).byteLength;

			const postInfo = await env.fileInfo(params.file_path, signal);
			if (postInfo.ok) tracker?.markWritten(path, postInfo.value.mtimeMs);

			const verb = created ? "Created" : append ? "Appended to" : "Updated";
			return {
				content: [{ type: "text", text: `${verb} ${path} (${bytesWritten} bytes)` }],
				details: { path, bytesWritten, created, appended: append },
			};
		},
	};
}
