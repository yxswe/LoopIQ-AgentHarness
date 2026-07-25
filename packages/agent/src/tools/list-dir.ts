import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv, FileInfo } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";

/** Directory names skipped during recursive listing. */
const IGNORED_DIRS = new Set([".git", "node_modules"]);

export const listDirToolSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list. Defaults to cwd." })),
	recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories." })),
});

export type ListDirToolParams = Static<typeof listDirToolSchema>;

export interface ListDirToolDetails {
	/** Number of entries returned. */
	entries: number;
}

/** Return `abs` expressed relative to `root`, falling back to the basename. */
function relativeTo(root: string, abs: string): string {
	if (abs.startsWith(root)) {
		const rest = abs.slice(root.length).replace(/^[\\/]+/, "");
		if (rest !== "") return rest;
	}
	const idx = Math.max(abs.lastIndexOf("/"), abs.lastIndexOf("\\"));
	return idx >= 0 ? abs.slice(idx + 1) : abs;
}

/** Recursively collect entries under `dir`, skipping ignored directories. */
async function collectRecursive(
	env: ExecutionEnv,
	dir: string,
	signal: AbortSignal | undefined,
	out: FileInfo[],
): Promise<void> {
	const listed = await env.listDir(dir, signal);
	if (!listed.ok) return;
	const entries = [...listed.value].sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (signal?.aborted) return;
		out.push(entry);
		if (entry.kind === "directory") {
			if (IGNORED_DIRS.has(entry.name)) continue;
			await collectRecursive(env, entry.path, signal, out);
		}
	}
}

/** Create the ListDir tool bound to an execution environment. */
export function createListDirTool(env: ExecutionEnv): AgentTool<typeof listDirToolSchema, ListDirToolDetails> {
	return {
		name: "ListDir",
		label: "ListDir",
		description: "List the contents of a directory, optionally recursively.",
		parameters: listDirToolSchema,
		async execute(_toolCallId, params, signal) {
			const rootResult = await env.absolutePath(params.path ?? ".", signal);
			if (!rootResult.ok) {
				throw new Error(`Invalid path: ${rootResult.error.message}`);
			}
			const root = rootResult.value;

			const infoResult = await env.fileInfo(root, signal);
			if (!infoResult.ok) {
				throw new Error(`Failed to access ${root}: ${infoResult.error.message}`);
			}
			if (infoResult.value.kind !== "directory") {
				throw new Error(`Not a directory: ${root}`);
			}

			const collected: FileInfo[] = [];
			if (params.recursive) {
				await collectRecursive(env, root, signal, collected);
			} else {
				const listed = await env.listDir(root, signal);
				if (!listed.ok) {
					throw new Error(`Failed to list ${root}: ${listed.error.message}`);
				}
				collected.push(...[...listed.value].sort((a, b) => a.name.localeCompare(b.name)));
			}

			const lines = collected.map((info) => {
				const rel = params.recursive ? relativeTo(root, info.path) : info.name;
				return info.kind === "directory" ? `${rel}/` : rel;
			});

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { entries: collected.length },
			};
		},
	};
}
