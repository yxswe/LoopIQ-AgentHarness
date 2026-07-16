import type { ExecutionEnv, ShellExecOptions } from "../../base/env.ts";
import { ExecutionError } from "../../base/env.ts";
import { err, ok, type Result, toError } from "../../base/types.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate.ts";

export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	onChunk?: (chunk: string) => void;
	/** When true, stderr is captured separately and returned in {@link ShellCaptureResult.stderr} instead of merged into output. */
	separateStderr?: boolean;
}

export interface ShellCaptureResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	/** Captured stderr, present only when {@link ShellCaptureOptions.separateStderr} was set. */
	stderr?: string;
}

function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined;

	const appendFullOutput = (text: string): void => {
		if (!fullOutputPath || captureError) return;
		const path = fullOutputPath;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const appendResult = await env.appendFile(path, text, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputPath || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({
				prefix: "bash-",
				suffix: ".log",
				abortSignal: options?.abortSignal,
			});
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value;
			const appendResult = await env.appendFile(tempFile.value, initialContent, options?.abortSignal);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	const onChunk = (chunk: string) => {
		try {
			totalBytes += encoder.encode(chunk).byteLength;
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			if (totalBytes > DEFAULT_MAX_BYTES && !fullOutputPath) {
				ensureFullOutputFile(outputChunks.join("") + text);
			} else {
				appendFullOutput(text);
			}
			outputChunks.push(text);
			outputBytes += text.length;
			while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
				const removed = outputChunks.shift()!;
				outputBytes -= removed.length;
			}
			options?.onChunk?.(text);
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	const stderrChunks: string[] = [];
	let stderrBytes = 0;
	const onStderrChunk = (chunk: string) => {
		try {
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			stderrChunks.push(text);
			stderrBytes += text.length;
			while (stderrBytes > maxOutputBytes && stderrChunks.length > 1) {
				const removed = stderrChunks.shift()!;
				stderrBytes -= removed.length;
			}
		} catch (error) {
			captureError = toExecutionError(error);
		}
	};

	const captureStderr = (): string | undefined => {
		if (!options?.separateStderr) return undefined;
		const joined = stderrChunks.join("");
		const truncation = truncateTail(joined);
		return truncation.truncated ? truncation.content : joined;
	};

	try {
		const result = await env.exec(command, {
			...(options ?? {}),
			onStdout: onChunk,
			onStderr: options?.separateStderr ? onStderrChunk : onChunk,
		});
		const tailOutput = outputChunks.join("");
		const truncationResult = truncateTail(tailOutput);
		if (truncationResult.truncated && !fullOutputPath) {
			ensureFullOutputFile(tailOutput);
		}
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);

		const stderr = captureStderr();

		if (!result.ok) {
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					output: truncationResult.truncated ? truncationResult.content : tailOutput,
					exitCode: undefined,
					cancelled: true,
					truncated: truncationResult.truncated,
					fullOutputPath,
					stderr,
				});
			}
			return err(result.error);
		}
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			output: truncationResult.truncated ? truncationResult.content : tailOutput,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath,
			stderr,
		});
	} catch (error) {
		return err(toExecutionError(error));
	}
}
