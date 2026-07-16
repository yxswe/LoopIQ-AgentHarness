import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import { truncateLine } from "./utils/truncate.ts";

/** Directory names skipped during recursive search. */
const IGNORED_DIRS = new Set([".git", "node_modules"]);

/** Maximum number of output entries emitted (files or lines). */
const DEFAULT_HEAD_LIMIT = 250;

/** Map a language `type` name to the file extensions it covers. */
const TYPE_EXTENSIONS: Record<string, string[]> = {
	ts: ["ts", "tsx", "mts", "cts"],
	js: ["js", "jsx", "mjs", "cjs"],
	py: ["py", "pyi"],
	go: ["go"],
	rust: ["rs"],
	java: ["java"],
	c: ["c", "h"],
	cpp: ["cpp", "cc", "cxx", "hpp", "hh"],
	json: ["json"],
	md: ["md", "markdown"],
	css: ["css", "scss", "sass"],
	html: ["html", "htm"],
	yaml: ["yaml", "yml"],
	sh: ["sh", "bash"],
};

export const grepToolSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression to search for (JavaScript regex syntax)." }),
	path: Type.Optional(Type.String({ description: "Directory or file to search. Defaults to cwd." })),
	glob: Type.Optional(Type.String({ description: "Filter files by basename glob, e.g. \"*.ts\"." })),
	type: Type.Optional(Type.String({ description: "Filter files by language type, e.g. \"ts\", \"py\", \"go\"." })),
	output_mode: Type.Optional(
		Type.Union([Type.Literal("content"), Type.Literal("files_with_matches"), Type.Literal("count")], {
			description: "content: matching lines; files_with_matches: file paths; count: per-file counts.",
		}),
	),
	before_context: Type.Optional(Type.Number({ description: "Lines of context before each match (content mode, like -B)." })),
	after_context: Type.Optional(Type.Number({ description: "Lines of context after each match (content mode, like -A)." })),
	context: Type.Optional(Type.Number({ description: "Lines of context before and after each match (content mode, like -C)." })),
	head_limit: Type.Optional(Type.Number({ description: "Limit the number of output entries." })),
	offset: Type.Optional(Type.Number({ description: "Skip this many leading output entries before applying head_limit." })),
	case_insensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive matching." })),
	multiline: Type.Optional(Type.Boolean({ description: "Match across line boundaries (dot matches newlines)." })),
});

export type GrepToolParams = Static<typeof grepToolSchema>;

export interface GrepToolDetails {
	/** Output mode used. */
	mode: "content" | "files_with_matches" | "count";
	/** Number of files containing at least one match. */
	matchingFiles: number;
	/** Total number of matching lines across all files. */
	matchingLines: number;
	/** Whether output was truncated by head_limit. */
	truncated: boolean;
}

/** Convert a basename glob (supporting * and ?) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
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

/** Lowercase file extension without the dot, or "" when none. */
function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Recursively collect file paths under `dir`, skipping ignored dirs and applying optional basename glob / extension filters. */
async function collectFiles(
	env: ExecutionEnv,
	dir: string,
	glob: RegExp | undefined,
	extSet: Set<string> | undefined,
	signal: AbortSignal | undefined,
	out: string[],
): Promise<void> {
	const listed = await env.listDir(dir, signal);
	if (!listed.ok) return;
	const entries = [...listed.value].sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (signal?.aborted) return;
		if (entry.kind === "directory") {
			if (IGNORED_DIRS.has(entry.name)) continue;
			await collectFiles(env, entry.path, glob, extSet, signal, out);
		} else if (entry.kind === "file") {
			if (glob && !glob.test(entry.name)) continue;
			if (extSet && !extSet.has(extensionOf(entry.name))) continue;
			out.push(entry.path);
		}
	}
}

interface GrepMatch {
	file: string;
	lineNo: number;
	text: string;
}

/** Split file content into lines, dropping a single trailing empty line from a final newline. */
function toLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Build content-mode entries with surrounding context lines and `--` separators between groups. */
function buildContextEntries(
	root: string,
	files: string[],
	linesByFile: Map<string, string[]>,
	matches: GrepMatch[],
	before: number,
	after: number,
): string[] {
	const entries: string[] = [];
	for (const file of files) {
		const fileMatches = matches.filter((m) => m.file === file);
		if (fileMatches.length === 0) continue;
		const lines = linesByFile.get(file) ?? [];
		const rel = relativeTo(root, file);
		const matchSet = new Set(fileMatches.map((m) => m.lineNo));
		const sorted = [...matchSet].sort((a, b) => a - b);

		const intervals: Array<[number, number]> = [];
		for (const lineNo of sorted) {
			const s = Math.max(1, lineNo - before);
			const e = Math.min(lines.length, lineNo + after);
			const last = intervals[intervals.length - 1];
			if (last && s <= last[1] + 1) {
				last[1] = Math.max(last[1], e);
			} else {
				intervals.push([s, e]);
			}
		}

		for (const [s, e] of intervals) {
			if (entries.length > 0) entries.push("--");
			for (let ln = s; ln <= e; ln++) {
				const text = truncateLine(lines[ln - 1] ?? "").text;
				entries.push(matchSet.has(ln) ? `${rel}:${ln}:${text}` : `${rel}-${ln}-${text}`);
			}
		}
	}
	return entries;
}

/** Create the Grep tool bound to an execution environment. */
export function createGrepTool(env: ExecutionEnv): AgentTool<typeof grepToolSchema, GrepToolDetails> {
	return {
		name: "Grep",
		label: "Grep",
		description: "Search file contents with a regular expression across a directory tree.",
		parameters: grepToolSchema,
		async execute(_toolCallId, params, signal) {
			const mode = params.output_mode ?? "files_with_matches";
			const multiline = params.multiline === true;
			const baseFlags = params.case_insensitive ? "i" : "";
			const lineRegex = new RegExp(params.pattern, multiline ? `${baseFlags}s` : baseFlags);
			const glob = params.glob ? globToRegExp(params.glob) : undefined;
			const extSet = params.type
				? new Set(TYPE_EXTENSIONS[params.type.toLowerCase()] ?? [params.type.toLowerCase()])
				: undefined;
			const before = params.context ?? params.before_context ?? 0;
			const after = params.context ?? params.after_context ?? 0;
			const offset = params.offset && params.offset > 0 ? params.offset : 0;

			const rootResult = await env.absolutePath(params.path ?? ".", signal);
			if (!rootResult.ok) {
				throw new Error(`Invalid search path: ${rootResult.error.message}`);
			}
			const root = rootResult.value;

			const infoResult = await env.fileInfo(root, signal);
			if (!infoResult.ok) {
				throw new Error(`Failed to access ${root}: ${infoResult.error.message}`);
			}

			const files: string[] = [];
			if (infoResult.value.kind === "file") {
				files.push(root);
			} else {
				await collectFiles(env, root, glob, extSet, signal, files);
			}

			const matches: GrepMatch[] = [];
			const perFileCounts = new Map<string, number>();
			const linesByFile = new Map<string, string[]>();
			for (const file of files) {
				const readResult = await env.readTextFile(file, signal);
				if (!readResult.ok) continue;
				const content = readResult.value;
				const lines = toLines(content);
				linesByFile.set(file, lines);

				if (multiline) {
					const scanner = new RegExp(params.pattern, `${baseFlags}gs`);
					let match: RegExpExecArray | null = scanner.exec(content);
					while (match !== null) {
						const lineNo = content.slice(0, match.index).split("\n").length;
						matches.push({ file, lineNo, text: lines[lineNo - 1] ?? "" });
						perFileCounts.set(file, (perFileCounts.get(file) ?? 0) + 1);
						if (match.index === scanner.lastIndex) scanner.lastIndex++;
						match = scanner.exec(content);
					}
				} else {
					for (let i = 0; i < lines.length; i++) {
						if (lineRegex.test(lines[i])) {
							matches.push({ file, lineNo: i + 1, text: lines[i] });
							perFileCounts.set(file, (perFileCounts.get(file) ?? 0) + 1);
						}
					}
				}
			}

			const matchingLines = matches.length;
			const matchingFiles = perFileCounts.size;
			const limit = params.head_limit ?? DEFAULT_HEAD_LIMIT;

			let entries: string[];
			if (mode === "content") {
				if (before > 0 || after > 0) {
					entries = buildContextEntries(root, files, linesByFile, matches, before, after);
				} else {
					entries = matches.map((m) => `${relativeTo(root, m.file)}:${m.lineNo}:${truncateLine(m.text).text}`);
				}
			} else if (mode === "count") {
				entries = [...perFileCounts.entries()].map(([file, count]) => `${relativeTo(root, file)}:${count}`);
			} else {
				entries = [...perFileCounts.keys()].map((file) => relativeTo(root, file));
			}

			const afterOffset = offset > 0 ? entries.slice(offset) : entries;
			const truncated = afterOffset.length > limit;
			const shown = truncated ? afterOffset.slice(0, limit) : afterOffset;

			return {
				content: [{ type: "text", text: shown.join("\n") }],
				details: { mode, matchingFiles, matchingLines, truncated },
			};
		},
	};
}
