#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { AgentEventEnvelope, AgentRunResult, AgentSession, ThinkingLevel } from "@loopiq/agent-core";
import { AgentHarnessError } from "@loopiq/agent-core";
import { createDefaultRuntime } from "./default-runtime.ts";

type OutputFormat = "text" | "json" | "jsonl";

interface ParsedOptions {
	command: "run" | "chat" | "sessions-list" | "sessions-create" | "sessions-delete";
	prompt?: string;
	sessionId?: string;
	newSession: boolean;
	cwd: string;
	model: string;
	thinking?: ThinkingLevel;
	format: OutputFormat;
	stdin: boolean;
	dataDir: string;
	deleteSessionId?: string;
}

function takeValue(args: string[], index: number, name: string): string {
	const value = args[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	args.splice(index, 2);
	return value;
}

export function parseArgs(argv: string[]): ParsedOptions {
	const args = [...argv];
	let command: ParsedOptions["command"] = "run";
	if (args[0] === "chat") {
		command = "chat";
		args.shift();
	} else if (args[0] === "run") {
		args.shift();
	} else if (args[0] === "sessions") {
		args.shift();
		const action = args.shift();
		if (action === "list") command = "sessions-list";
		else if (action === "create") command = "sessions-create";
		else if (action === "delete") command = "sessions-delete";
		else throw new Error("sessions requires list, create, or delete");
	}

	const options: ParsedOptions = {
		command,
		newSession: false,
		cwd: process.cwd(),
		model: process.env.LOOPIQ_MODEL ?? "github-copilot/claude-opus-4.6",
		format: "text",
		stdin: false,
		dataDir: process.env.LOOPIQ_DATA_DIR ?? resolve(homedir(), ".loopiq"),
	};
	for (let index = 0; index < args.length; ) {
		const argument = args[index]!;
		if (argument === "--session") options.sessionId = takeValue(args, index, argument);
		else if (argument === "--new") {
			options.newSession = true;
			args.splice(index, 1);
		} else if (argument === "--cwd") options.cwd = resolve(takeValue(args, index, argument));
		else if (argument === "--model") options.model = takeValue(args, index, argument);
		else if (argument === "--thinking") options.thinking = takeValue(args, index, argument) as ThinkingLevel;
		else if (argument === "--format") options.format = takeValue(args, index, argument) as OutputFormat;
		else if (argument === "--data-dir") options.dataDir = resolve(takeValue(args, index, argument));
		else if (argument === "--stdin") {
			options.stdin = true;
			args.splice(index, 1);
		} else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}`);
		else index++;
	}
	if (!(["text", "json", "jsonl"] as string[]).includes(options.format)) throw new Error("Invalid output format");
	if (options.sessionId && options.newSession) throw new Error("--session and --new are mutually exclusive");
	if (options.stdin && args.length > 0) throw new Error("prompt argument and --stdin are mutually exclusive");
	if (command === "sessions-delete") options.deleteSessionId = args.shift();
	else options.prompt = args.join(" ") || undefined;
	return options;
}

async function readStdin(): Promise<string> {
	let content = "";
	for await (const chunk of stdin) content += chunk;
	return content;
}

function safeEnvelope(envelope: AgentEventEnvelope): AgentEventEnvelope {
	if (envelope.event.type !== "after_provider_response") return envelope;
	return {
		...envelope,
		event: {
			...envelope.event,
			headers: Object.fromEntries(
				Object.entries(envelope.event.headers).map(([name, value]) => [
					name,
					/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(name) ? "[redacted]" : value,
				]),
			),
		},
	};
}

function attachRenderer(session: AgentSession, format: OutputFormat): () => void {
	if (format === "json") return () => {};
	return session.subscribe((rawEnvelope) => {
		const envelope = safeEnvelope(rawEnvelope);
		if (format === "jsonl") {
			stdout.write(`${JSON.stringify(envelope)}\n`);
			return;
		}
		if (envelope.event.type === "message_update" && envelope.event.assistantMessageEvent.type === "text_delta") {
			stdout.write(envelope.event.assistantMessageEvent.delta);
		}
	});
}

function serializeResult(result: AgentRunResult) {
	return {
		...result,
		error: result.error
			? { message: result.error.message, code: "code" in result.error ? result.error.code : "unknown" }
			: undefined,
	};
}

async function selectSession(options: ParsedOptions, host: Awaited<ReturnType<typeof createDefaultRuntime>>["host"]) {
	if (options.sessionId) return host.open(options.sessionId);
	return host.create({
		cwd: options.cwd,
		model: (() => {
			const separator = options.model.indexOf("/");
			return { providerId: options.model.slice(0, separator), modelId: options.model.slice(separator + 1) };
		})(),
		thinkingLevel: options.thinking,
	});
}

async function runOnce(options: ParsedOptions): Promise<number> {
	const prompt = options.stdin ? await readStdin() : options.prompt;
	if (!prompt?.trim()) throw new Error("A non-empty prompt or --stdin is required");
	const runtime = await createDefaultRuntime(options.dataDir, options.model);
	const session = await selectSession(options, runtime.host);
	const unsubscribe = attachRenderer(session, options.format);
	if (
		options.sessionId &&
		(session.getModel().provider !== runtime.model.provider || session.getModel().id !== runtime.model.id)
	) {
		await session.setModel(runtime.model);
	}
	if (options.thinking && session.getThinkingLevel() !== options.thinking)
		await session.setThinkingLevel(options.thinking);
	const handle = session.startRun({ text: prompt });
	let interrupted = false;
	const onSignal = () => {
		if (interrupted) process.exit(130);
		interrupted = true;
		void session.abort(handle.runId);
	};
	process.on("SIGINT", onSignal);
	try {
		const result = await handle.result;
		if (options.format === "json") stdout.write(`${JSON.stringify(serializeResult(result))}\n`);
		else if (options.format === "text") stdout.write("\n");
		return interrupted || result.status === "aborted" ? 130 : result.status === "completed" ? 0 : 1;
	} finally {
		process.off("SIGINT", onSignal);
		unsubscribe();
		await runtime.host.shutdown();
	}
}

async function runChat(options: ParsedOptions): Promise<number> {
	const runtime = await createDefaultRuntime(options.dataDir, options.model);
	const session = await selectSession(options, runtime.host);
	const unsubscribe = attachRenderer(session, options.format);
	const readline = createInterface({ input: stdin, output: process.stderr });
	try {
		while (true) {
			const input = await readline.question("> ");
			if (!input || input === "/exit") break;
			const result = await session.startRun({ text: input }).result;
			if (options.format === "json") stdout.write(`${JSON.stringify(serializeResult(result))}\n`);
			else if (options.format === "text") stdout.write("\n");
		}
		return 0;
	} finally {
		readline.close();
		unsubscribe();
		await runtime.host.shutdown({ abortRunning: true });
	}
}

async function runSessionCommand(options: ParsedOptions): Promise<number> {
	const runtime = await createDefaultRuntime(options.dataDir, options.model);
	try {
		if (options.command === "sessions-list") {
			const sessions = await runtime.host.list();
			if (options.format === "text") {
				for (const session of sessions) stdout.write(`${session.id}\t${session.cwd}\t${session.loadedState}\n`);
			} else stdout.write(`${JSON.stringify(sessions)}\n`);
			return 0;
		}
		if (options.command === "sessions-create") {
			const session = await selectSession({ ...options, sessionId: undefined }, runtime.host);
			stdout.write(`${options.format === "text" ? session.id : JSON.stringify(session.getSnapshot())}\n`);
			return 0;
		}
		if (!options.deleteSessionId) throw new Error("sessions delete requires a Session ID");
		await runtime.host.delete(options.deleteSessionId);
		return 0;
	} finally {
		await runtime.host.shutdown();
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const options = parseArgs(argv);
	if (options.command === "run") return runOnce(options);
	if (options.command === "chat") return runChat(options);
	return runSessionCommand(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode =
				error instanceof AgentHarnessError
					? error.code === "session_locked" || error.code === "session"
						? 4
						: error.code === "auth"
							? 3
							: 1
					: 2;
		});
}
