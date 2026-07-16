import { type Static, Type } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentTool } from "../base/resource.ts";
import { executeShellWithCapture } from "./utils/shell-output.ts";

export const bashToolSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute." }),
	description: Type.Optional(Type.String({ description: "Short human-readable description of what the command does." })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds. Defaults to no timeout." })),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the environment cwd." })),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Run the command in the background, returning immediately with a log path to read output from later.",
		}),
	),
});

export type BashToolParams = Static<typeof bashToolSchema>;

export interface BashToolDetails {
	/** Exit code, or undefined when cancelled or backgrounded. */
	exitCode: number | undefined;
	/** Whether execution was cancelled via abort. */
	cancelled: boolean;
	/** Whether the captured output was truncated. */
	truncated: boolean;
	/** Path to the full output file when truncation spilled to disk. */
	fullOutputPath?: string;
	/** Model-provided description of the command, when given. */
	description?: string;
	/** True when the command was started in the background. */
	background?: boolean;
	/** Identifier of the background command, when backgrounded. */
	backgroundId?: string;
	/** Path the background command streams its output to. */
	logPath?: string;
}

/** Start a detached background command, streaming its output to `logPath`. Does not await completion. */
function startBackgroundCommand(env: ExecutionEnv, command: string, cwd: string | undefined, logPath: string): void {
	let chain: Promise<unknown> = env.appendFile(logPath, `# background: ${command}\n`);
	const append = (text: string): void => {
		chain = chain.then(() => env.appendFile(logPath, text)).catch(() => {});
	};
	// Intentionally not tied to the turn abort signal, so the command survives
	// turn completion. Output is streamed to the log file for later retrieval.
	void env
		.exec(command, { cwd, onStdout: append, onStderr: append })
		.then((res) => {
			append(res.ok ? `\n[exit ${res.value.exitCode}]\n` : `\n[error: ${res.error.message}]\n`);
		})
		.catch(() => {});
}

/** Create the Bash tool bound to an execution environment. */
export function createBashTool(env: ExecutionEnv): AgentTool<typeof bashToolSchema, BashToolDetails> {
	return {
		name: "Bash",
		label: "Bash",
		description: "Execute a shell command and return its stdout, with stderr reported separately.",
		parameters: bashToolSchema,
		async execute(_toolCallId, params, signal, onUpdate) {
			if (params.run_in_background) {
				const logResult = await env.createTempFile({ prefix: "bash-bg-", suffix: ".log", abortSignal: signal });
				if (!logResult.ok) {
					throw new Error(`Failed to create background log: ${logResult.error.message}`);
				}
				const logPath = logResult.value;
				const backgroundId = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
				startBackgroundCommand(env, params.command, params.cwd, logPath);
				return {
					content: [
						{
							type: "text",
							text: `Started background command ${backgroundId}.\nOutput is being written to: ${logPath}\nUse Read or Bash (e.g. \`cat ${logPath}\`) to inspect it.`,
						},
					],
					details: {
						exitCode: undefined,
						cancelled: false,
						truncated: false,
						background: true,
						backgroundId,
						logPath,
						description: params.description,
					},
				};
			}

			let streamed = "";
			const result = await executeShellWithCapture(env, params.command, {
				cwd: params.cwd,
				timeout: params.timeout,
				abortSignal: signal,
				separateStderr: true,
				onChunk: (chunk) => {
					streamed += chunk;
					onUpdate?.({
						content: [{ type: "text", text: streamed }],
						details: { exitCode: undefined, cancelled: false, truncated: false, description: params.description },
					});
				},
			});
			if (!result.ok) {
				throw new Error(`Command failed: ${result.error.message}`);
			}

			const { output, stderr, exitCode, cancelled, truncated, fullOutputPath } = result.value;
			const sections: string[] = [];
			if (output) sections.push(output);
			if (stderr && stderr.trim() !== "") sections.push(`STDERR:\n${stderr}`);
			const text = sections.join("\n");

			return {
				content: [{ type: "text", text }],
				details: { exitCode, cancelled, truncated, fullOutputPath, description: params.description },
			};
		},
	};
}
