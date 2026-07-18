import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv, FileInfo } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
const IGNORED_DIRS = new Set([".git", "node_modules"]);

/** Maximum number of results returned. */
const DEFAULT_LIMIT = 250;

export const globToolSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern, e.g. \"**/*.ts\" or \"src/*.{js,jsx}\". Supports **, *, ? and {a,b} brace expansion.",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search from. Defaults to cwd." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
	max_depth: Type.Optional(Type.Number({ description: "Maximum directory depth to recurse into (1 = direct children only)." })),
	absolute: Type.Optional(Type.Boolean({ description: "Return absolute paths instead of paths relative to the search root." })),
});

export type GlobToolParams = Static<typeof globToolSchema>;

export interface GlobToolDetails {
	/** Number of files returned. */
	matches: number;
	/** Whether results were truncated by the limit. */
	truncated: boolean;
}

/** Expand `{a,b}` brace groups into the cartesian product of concrete patterns. */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const pre = pattern.slice(0, open);
	const post = pattern.slice(close + 1);
	const options = pattern.slice(open + 1, close).split(",");
	const results: string[] = [];
	for (const option of options) {
		for (const expanded of expandBraces(pre + option + post)) {
			results.push(expanded);
		}
	}
	return results;
}

/** Convert a path glob (supporting **, * and ?) into an anchored RegExp matched against relative paths. */
export function globToPathRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				i++;
				if (glob[i + 1] === "/") {
					i++;
					re += "(?:.*/)?";
				} else {
					re += ".*";
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (".+^${}()|[]\\".includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
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

/** Recursively collect file infos under `dir`, skipping ignored directories and honoring an optional max depth. */
async function collectFileInfos(
	env: ExecutionEnv,
	dir: string,
	depth: number,
	maxDepth: number | undefined,
	signal: AbortSignal | undefined,
	out: FileInfo[],
): Promise<void> {
	const listed = await env.listDir(dir, signal);
	if (!listed.ok) return;
	const childDepth = depth + 1;
	for (const entry of listed.value) {
		if (signal?.aborted) return;
		if (entry.kind === "directory") {
			if (IGNORED_DIRS.has(entry.name)) continue;
			if (maxDepth !== undefined && childDepth >= maxDepth) continue;
			await collectFileInfos(env, entry.path, childDepth, maxDepth, signal, out);
		} else if (entry.kind === "file") {
			if (maxDepth !== undefined && childDepth > maxDepth) continue;
			out.push(entry);
		}
	}
}

/** Create the Glob tool bound to an execution environment. */
export function createGlobTool(env: ExecutionEnv): AgentTool<typeof globToolSchema, GlobToolDetails> {
	return {
		name: "Glob",
		label: "Glob",
		description: "Find files matching a glob pattern, sorted by most recently modified first.",
		parameters: globToolSchema,
		async execute(_toolCallId, params, signal) {
			const regexes = expandBraces(params.pattern).map(globToPathRegExp);

			const rootResult = await env.absolutePath(params.path ?? ".", signal);
			if (!rootResult.ok) {
				throw new Error(`Invalid search path: ${rootResult.error.message}`);
			}
			const root = rootResult.value;

			const infos: FileInfo[] = [];
			await collectFileInfos(env, root, 0, params.max_depth, signal, infos);

			const seen = new Set<string>();
			const matched = infos
				.map((info) => ({ info, rel: relativeTo(root, info.path) }))
				.filter((entry) => {
					if (!regexes.some((re) => re.test(entry.rel))) return false;
					if (seen.has(entry.info.path)) return false;
					seen.add(entry.info.path);
					return true;
				})
				.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);

			const limit = params.limit ?? DEFAULT_LIMIT;
			const truncated = matched.length > limit;
			const shown = truncated ? matched.slice(0, limit) : matched;

			return {
				content: [
					{ type: "text", text: shown.map((entry) => (params.absolute ? entry.info.path : entry.rel)).join("\n") },
				],
				details: { matches: matched.length, truncated },
			};
		},
	};
}
