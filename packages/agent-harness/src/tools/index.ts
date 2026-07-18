import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createGlobTool } from "./glob.ts";
import { createGrepTool } from "./grep.ts";
import { createListDirTool } from "./list-dir.ts";
import { createReadTool } from "./read.ts";
import { createFileAccessTracker } from "./utils/file-access-tracker.ts";
import { createWriteTool } from "./write.ts";

export { createBashTool, type BashToolDetails, type BashToolParams, bashToolSchema } from "./bash.ts";
export { createEditTool, type EditToolDetails, type EditToolParams, editToolSchema } from "./edit.ts";
export { createGlobTool, type GlobToolDetails, type GlobToolParams, globToolSchema } from "./glob.ts";
export { createGrepTool, type GrepToolDetails, type GrepToolParams, grepToolSchema } from "./grep.ts";
export { createListDirTool, type ListDirToolDetails, type ListDirToolParams, listDirToolSchema } from "./list-dir.ts";
export { createReadTool, type ReadToolDetails, type ReadToolParams, readToolSchema } from "./read.ts";
export { createFileAccessTracker, type FileAccessTracker } from "./utils/file-access-tracker.ts";
export { createWriteTool, type WriteToolDetails, type WriteToolParams, writeToolSchema } from "./write.ts";

/**
 * Build the default built-in tool set bound to an execution environment:
 * Read, Write, Edit, Bash, Grep, Glob, and ListDir.
 *
 * Read, Write, and Edit share a single {@link FileAccessTracker} so that
 * overwriting or editing an existing file requires it to have been read first.
 */
export function createDefaultTools(env: ExecutionEnv): AgentTool[] {
	const tracker = createFileAccessTracker();
	return [
		createReadTool(env, tracker),
		createWriteTool(env, tracker),
		createEditTool(env, tracker),
		createBashTool(env),
		createGrepTool(env),
		createGlobTool(env),
		createListDirTool(env),
	];
}
