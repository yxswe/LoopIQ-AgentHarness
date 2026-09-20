#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
	type Agent,
	type AgentConfiguration,
	type AgentEventEnvelope,
	AgentRuntimeError,
	createAgent,
	type ModelReference,
	type ModelSummary,
	type ProviderAuthMethod,
	type ProviderLoginInteraction,
	type ProviderRequestPolicy,
	type ProviderSummary,
	type RunHandle,
	type RunResult,
	type SessionSnapshot,
	type SessionSummary,
	type ThinkingLevel,
} from "@loopiq/agent";

const PACKAGE = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const CLI_EVENT_SCHEMA = "loopiq.cli.event";
const CLI_EVENT_SCHEMA_VERSION = 1;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 64 * 1024;

type OutputFormat = "text" | "json" | "jsonl";
type Command =
	| "help"
	| "version"
	| "run"
	| "chat"
	| "sessions-list"
	| "sessions-delete"
	| "providers-list"
	| "providers-add"
	| "providers-validate"
	| "providers-remove"
	| "models-list"
	| "config-get"
	| "config-set-model"
	| "config-set-thinking"
	| "config-set-provider-request";

export interface ParsedOptions {
	command: Command;
	prompt?: string;
	sessionId?: string;
	continueSession: boolean;
	workspaceDir: string;
	workspaceExplicit: boolean;
	model?: string;
	thinking?: ThinkingLevel;
	format: OutputFormat;
	stdin: boolean;
	target?: string;
	authMethod?: ProviderAuthMethod;
	tokenStdin: boolean;
	refresh: boolean;
	providerRequest?: Partial<ProviderRequestPolicy>;
}

export class CliUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}

function defaultOptions(command: Command): ParsedOptions {
	return {
		command,
		continueSession: false,
		workspaceDir: process.cwd(),
		workspaceExplicit: false,
		format: "text",
		stdin: false,
		tokenStdin: false,
		refresh: false,
	};
}

function takeValue(args: string[], index: number, name: string): string {
	const value = args[index + 1];
	if (!value) throw new CliUsageError(`${name} requires a value`);
	args.splice(index, 2);
	return value;
}

function takeTarget(args: string[], message: string): string {
	const target = args.shift();
	if (!target || target.startsWith("-")) throw new CliUsageError(message);
	return target;
}

function takeInteger(args: string[], index: number, name: string, minimum: number): number {
	const value = Number(takeValue(args, index, name));
	if (!Number.isInteger(value) || value < minimum) {
		throw new CliUsageError(`${name} requires an integer greater than or equal to ${minimum}`);
	}
	return value;
}

function requireCommand(command: Command, option: string, allowed: readonly Command[]): void {
	if (!allowed.includes(command)) throw new CliUsageError(`${option} is not valid for this command`);
}

function parseCommand(args: string[]): { command: Command; target?: string } {
	const group = args.shift();
	if (!group) return { command: "help" };
	if (group === "run" || group === "chat") return { command: group };
	if (group === "sessions") {
		const action = args.shift();
		if (action === "list") return { command: "sessions-list" };
		if (action === "delete") {
			return { command: "sessions-delete", target: takeTarget(args, "sessions delete requires a Session ID") };
		}
		throw new CliUsageError("sessions requires list or delete");
	}
	if (group === "providers") {
		const action = args.shift();
		if (action === "list") return { command: "providers-list" };
		if (action === "add") {
			return { command: "providers-add", target: takeTarget(args, "providers add requires a Provider ID") };
		}
		if (action === "validate") {
			return {
				command: "providers-validate",
				target: takeTarget(args, "providers validate requires a Provider ID"),
			};
		}
		if (action === "remove") {
			return { command: "providers-remove", target: takeTarget(args, "providers remove requires a Provider ID") };
		}
		throw new CliUsageError("providers requires list, add, validate, or remove");
	}
	if (group === "models") {
		if (args.shift() !== "list") throw new CliUsageError("models requires list");
		return {
			command: "models-list",
			target: args[0] && !args[0]!.startsWith("-") ? args.shift() : undefined,
		};
	}
	if (group === "config") {
		const action = args.shift();
		if (action === "get") return { command: "config-get" };
		if (action === "set-model") {
			return { command: "config-set-model", target: takeTarget(args, "config set-model requires provider/model") };
		}
		if (action === "set-thinking") {
			return { command: "config-set-thinking", target: takeTarget(args, "config set-thinking requires a level") };
		}
		if (action === "set-provider-request") return { command: "config-set-provider-request" };
		throw new CliUsageError("config requires get, set-model, set-thinking, or set-provider-request");
	}
	throw new CliUsageError(`Unknown command ${group}`);
}

export function parseArgs(argv: string[]): ParsedOptions {
	if (argv.length === 0) return defaultOptions("help");
	if (argv.includes("--help") || argv.includes("-h")) return defaultOptions("help");

	const args = [...argv];
	if (args[0] === "--version" || args[0] === "-v") {
		const versionArgs = args.slice(1);
		const options = defaultOptions("version");
		if (
			versionArgs.length === 2 &&
			versionArgs[0] === "--format" &&
			(versionArgs[1] === "text" || versionArgs[1] === "json")
		) {
			options.format = versionArgs[1];
			return options;
		}
		if (versionArgs.length > 0) throw new CliUsageError("--version accepts only --format text|json");
		return options;
	}

	const parsedCommand = parseCommand(args);
	const options = { ...defaultOptions(parsedCommand.command), target: parsedCommand.target };
	const positional: string[] = [];
	for (let index = 0; index < args.length; ) {
		const argument = args[index]!;
		if (argument === "--") {
			positional.push(...args.slice(index + 1));
			args.splice(index);
			break;
		}
		if (argument === "--session") {
			requireCommand(options.command, argument, ["run", "chat"]);
			options.sessionId = takeValue(args, index, argument);
		} else if (argument === "--continue") {
			requireCommand(options.command, argument, ["run", "chat"]);
			options.continueSession = true;
			args.splice(index, 1);
		} else if (argument === "--workspace") {
			requireCommand(options.command, argument, ["run", "chat"]);
			options.workspaceDir = resolve(takeValue(args, index, argument));
			options.workspaceExplicit = true;
		} else if (argument === "--model") {
			requireCommand(options.command, argument, ["run", "chat"]);
			options.model = takeValue(args, index, argument);
		} else if (argument === "--thinking") {
			requireCommand(options.command, argument, ["run", "chat"]);
			const thinking = takeValue(args, index, argument);
			if (!isThinkingLevel(thinking)) throw new CliUsageError("--thinking is invalid");
			options.thinking = thinking;
		} else if (argument === "--format") {
			requireCommand(options.command, argument, [
				"version",
				"run",
				"sessions-list",
				"sessions-delete",
				"providers-list",
				"providers-add",
				"providers-validate",
				"providers-remove",
				"models-list",
				"config-get",
				"config-set-model",
				"config-set-thinking",
				"config-set-provider-request",
			]);
			const format = takeValue(args, index, argument);
			if (format !== "text" && format !== "json" && format !== "jsonl") {
				throw new CliUsageError("--format must be text, json, or jsonl");
			}
			options.format = format;
		} else if (argument === "--stdin") {
			requireCommand(options.command, argument, ["run"]);
			options.stdin = true;
			args.splice(index, 1);
		} else if (argument === "--auth-method") {
			requireCommand(options.command, argument, ["providers-add"]);
			const method = takeValue(args, index, argument);
			if (method !== "api_token" && method !== "oauth") {
				throw new CliUsageError("--auth-method must be api_token or oauth");
			}
			options.authMethod = method;
		} else if (argument === "--token-stdin") {
			requireCommand(options.command, argument, ["providers-add"]);
			options.tokenStdin = true;
			args.splice(index, 1);
		} else if (argument === "--refresh") {
			requireCommand(options.command, argument, ["models-list"]);
			options.refresh = true;
			args.splice(index, 1);
		} else if (argument === "--transport") {
			requireCommand(options.command, argument, ["config-set-provider-request"]);
			const transport = takeValue(args, index, argument);
			if (!(["auto", "sse", "websocket", "websocket-cached"] as string[]).includes(transport)) {
				throw new CliUsageError("--transport is invalid");
			}
			options.providerRequest ??= {};
			options.providerRequest.transport = transport as ProviderRequestPolicy["transport"];
		} else if (argument === "--timeout-ms") {
			requireCommand(options.command, argument, ["config-set-provider-request"]);
			options.providerRequest ??= {};
			options.providerRequest.timeoutMs = takeInteger(args, index, argument, 1);
		} else if (argument === "--max-retries") {
			requireCommand(options.command, argument, ["config-set-provider-request"]);
			options.providerRequest ??= {};
			options.providerRequest.maxRetries = takeInteger(args, index, argument, 0);
		} else if (argument === "--max-retry-delay-ms") {
			requireCommand(options.command, argument, ["config-set-provider-request"]);
			options.providerRequest ??= {};
			options.providerRequest.maxRetryDelayMs = takeInteger(args, index, argument, 0);
		} else if (argument === "--cache-retention") {
			requireCommand(options.command, argument, ["config-set-provider-request"]);
			const retention = takeValue(args, index, argument);
			if (retention !== "none" && retention !== "short" && retention !== "long") {
				throw new CliUsageError("--cache-retention must be none, short, or long");
			}
			options.providerRequest ??= {};
			options.providerRequest.cacheRetention = retention;
		} else if (argument.startsWith("-")) {
			throw new CliUsageError(`Unknown option ${argument}`);
		} else {
			positional.push(argument);
			args.splice(index, 1);
		}
	}

	if (options.command === "run" || options.command === "chat") options.prompt = positional.join(" ") || undefined;
	else if (positional.length > 0) throw new CliUsageError(`Unexpected argument ${positional[0]}`);

	if (options.command === "run" && options.stdin === Boolean(options.prompt)) {
		throw new CliUsageError("run requires exactly one prompt argument or --stdin");
	}
	if (options.sessionId && options.continueSession) {
		throw new CliUsageError("--session and --continue are mutually exclusive");
	}
	if (options.sessionId && options.workspaceExplicit) {
		throw new CliUsageError("--workspace cannot be combined with --session");
	}
	if ((options.sessionId || options.continueSession) && (options.model || options.thinking)) {
		throw new CliUsageError("model and thinking overrides apply only to a new Session");
	}
	if (options.command !== "run" && options.format === "jsonl") {
		throw new CliUsageError("--format jsonl is supported only by run");
	}
	if (options.command === "providers-add" && options.tokenStdin) {
		if (options.authMethod === "oauth") throw new CliUsageError("--token-stdin cannot be used with OAuth");
		options.authMethod = "api_token";
	}
	if (options.command === "config-set-provider-request" && !options.providerRequest) {
		throw new CliUsageError("config set-provider-request requires at least one request option");
	}
	return options;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function parseModelReference(value: string): ModelReference {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) {
		throw new CliUsageError("Model must use provider/model format");
	}
	return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

async function readLimitedStdin(maxBytes: number, label: string): Promise<string> {
	let content = "";
	let bytes = 0;
	for await (const chunk of stdin) {
		const text = String(chunk);
		bytes += Buffer.byteLength(text);
		if (bytes > maxBytes) throw new CliUsageError(`${label} exceeds ${maxBytes} bytes`);
		content += text;
	}
	return content;
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).map(([name, value]) => [
			name,
			/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i.test(name) ? "[redacted]" : value,
		]),
	);
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => {
			return Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string");
		})
		.map((part) => part.text)
		.join("");
}

function eventRecord(type: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
	return { schema: CLI_EVENT_SCHEMA, schemaVersion: CLI_EVENT_SCHEMA_VERSION, type, ...fields };
}

function mapEnvelope(envelope: AgentEventEnvelope): Record<string, unknown> | undefined {
	const event = envelope.event;
	const identity = {
		sessionId: envelope.sessionId,
		runtimeId: envelope.runtimeId,
		runId: envelope.runId,
		sourceSequence: envelope.sequence,
		timestamp: envelope.timestamp,
	};
	switch (event.type) {
		case "message_start":
			return eventRecord("message_started", { ...identity, role: event.message.role });
		case "message_update":
			return eventRecord("message_delta", { ...identity, update: event.update });
		case "message_end":
			return eventRecord("message_completed", { ...identity, message: event.message });
		case "tool_execution_start":
			return eventRecord("tool_started", {
				...identity,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				arguments: event.args,
			});
		case "tool_execution_update":
			return eventRecord("tool_progress", {
				...identity,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
			});
		case "tool_execution_end":
			return eventRecord("tool_completed", {
				...identity,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			});
		case "context_compaction_started":
		case "context_compaction_completed":
		case "context_compaction_failed": {
			const { type: name, ...details } = event;
			return eventRecord("context_compaction", { ...identity, name, ...details });
		}
		case "after_provider_response":
			return eventRecord("provider_response", {
				...identity,
				status: event.status,
				headers: safeHeaders(event.headers),
			});
		case "model_update":
			return eventRecord("session_model_changed", {
				...identity,
				model: { providerId: event.model.provider, modelId: event.model.id },
				previousModel: { providerId: event.previousModel.provider, modelId: event.previousModel.id },
			});
		case "thinking_level_update":
			return eventRecord("session_thinking_changed", {
				...identity,
				level: event.level,
				previousLevel: event.previousLevel,
			});
		case "steering_queue_update":
			return eventRecord("steering_queue_changed", { ...identity, messageCount: event.messages.length });
		case "save_point":
			return eventRecord("save_point", { ...identity, hadPendingMutations: event.hadPendingMutations });
		case "agent_start":
		case "agent_end":
		case "turn_start":
		case "turn_end":
			return eventRecord("lifecycle", { ...identity, name: event.type });
		case "run_settled":
			return undefined;
	}
}

function aggregateUsage(result: RunResult): Record<string, unknown> {
	let messages = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	for (const message of result.messages) {
		if (message.role !== "assistant" || !("usage" in message) || !message.usage) continue;
		messages++;
		inputTokens += message.usage.input ?? 0;
		outputTokens += message.usage.output ?? 0;
		cacheReadTokens += message.usage.cacheRead ?? 0;
		cacheWriteTokens += message.usage.cacheWrite ?? 0;
		costUsd += message.usage.cost?.total ?? 0;
	}
	return {
		state: messages > 0 ? "partial" : "unknown",
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
		inferenceMessages: messages,
		note: messages > 0 ? "Context-compaction inference is not included" : undefined,
	};
}

function errorDetails(error: unknown): { code: string; message: string } {
	return {
		code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
		message: error instanceof Error ? error.message : String(error),
	};
}

function terminalRecord(result: RunResult, cleanupError?: unknown): Record<string, unknown> {
	const stopReason = result.finalMessage?.stopReason;
	const lengthLimited = stopReason === "length";
	const status = cleanupError || lengthLimited ? "failed" : result.status;
	const error = cleanupError
		? { code: "shutdown_failed", message: errorDetails(cleanupError).message }
		: lengthLimited
			? { code: "output_limit", message: "Provider output reached its length limit" }
			: result.error
				? errorDetails(result.error)
				: undefined;
	return eventRecord("run_completed", {
		sessionId: result.sessionId,
		runId: result.runId,
		status,
		reason: cleanupError ? "shutdown_failed" : lengthLimited ? "length" : result.status,
		stopReason,
		finalMessage: result.finalMessage,
		usage: aggregateUsage(result),
		error,
	});
}

interface RunOutput {
	onEnvelope(envelope: AgentEventEnvelope): void;
	start(session: SessionSnapshot, handle: RunHandle): void;
	complete(result: RunResult, cleanupError?: unknown): void;
}

function createRunOutput(format: OutputFormat): RunOutput {
	let started = false;
	let wroteText = false;
	let finalText = "";
	const buffered: AgentEventEnvelope[] = [];
	const render = (envelope: AgentEventEnvelope) => {
		if (format === "jsonl") {
			const record = mapEnvelope(envelope);
			if (record) stdout.write(`${JSON.stringify(record)}\n`);
			return;
		}
		if (format !== "text") return;
		const event = envelope.event;
		if (event.type === "message_update" && event.update.type === "text_delta") {
			stdout.write(event.update.delta);
			wroteText = true;
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			finalText = messageText(event.message);
		} else if (event.type === "tool_execution_start") stderr.write(`Using ${event.toolName}…\n`);
		else if (event.type === "context_compaction_started") stderr.write("Compacting context…\n");
	};
	return {
		onEnvelope(envelope) {
			if (started) render(envelope);
			else buffered.push(envelope);
		},
		start(session, handle) {
			started = true;
			if (format === "jsonl") {
				stdout.write(
					`${JSON.stringify(
						eventRecord("run_started", {
							sessionId: handle.sessionId,
							runId: handle.runId,
							workspaceDir: session.workspaceDir,
							model: session.model,
							thinkingLevel: session.thinkingLevel,
							timestamp: new Date().toISOString(),
							cliVersion: PACKAGE.version,
						}),
					)}\n`,
				);
			}
			for (const envelope of buffered.splice(0)) render(envelope);
		},
		complete(result, cleanupError) {
			const terminal = terminalRecord(result, cleanupError);
			if (format === "jsonl" || format === "json") stdout.write(`${JSON.stringify(terminal)}\n`);
			else {
				if (!wroteText && finalText) stdout.write(finalText);
				stdout.write("\n");
				if (terminal.status !== "completed") {
					const error = terminal.error as { code: string; message: string } | undefined;
					stderr.write(`Error${error ? ` [${error.code}]: ${error.message}` : ""}\n`);
				}
			}
		},
	};
}

async function selectSession(options: ParsedOptions, agent: Agent): Promise<SessionSnapshot> {
	if (options.sessionId) return agent.getSession(options.sessionId);
	if (options.continueSession) {
		const sessions = (await agent.listSessions())
			.filter((session) => session.workspaceDir === options.workspaceDir)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
		if (!sessions[0]) throw new CliUsageError(`No Session exists for workspace ${options.workspaceDir}`);
		return agent.getSession(sessions[0].id);
	}
	return agent.createSession({
		workspaceDir: options.workspaceDir,
		model: options.model ? parseModelReference(options.model) : undefined,
		thinkingLevel: options.thinking,
	});
}

function resultExitCode(result: RunResult, cleanupError?: unknown, interrupted = false): number {
	if (interrupted || result.status === "aborted") return 130;
	if (cleanupError || result.status === "failed" || result.finalMessage?.stopReason === "length") return 1;
	return 0;
}

async function executeRun(
	agent: Agent,
	session: SessionSnapshot,
	prompt: string,
	output: RunOutput,
	signal: AbortSignal,
): Promise<RunResult> {
	const unsubscribe = await agent.subscribe(session.id, output.onEnvelope);
	let handle: RunHandle | undefined;
	const abort = () => {
		if (handle) void agent.abort(handle.sessionId, handle.runId).catch(() => {});
	};
	if (!signal.aborted) signal.addEventListener("abort", abort, { once: true });
	try {
		handle = await agent.run(session.id, { text: prompt });
		output.start(session, handle);
		if (signal.aborted) abort();
		return await handle.result;
	} finally {
		signal.removeEventListener("abort", abort);
		unsubscribe();
	}
}

async function runOnce(options: ParsedOptions): Promise<number> {
	const prompt = options.stdin ? await readLimitedStdin(MAX_PROMPT_BYTES, "Prompt") : options.prompt!;
	if (!prompt.trim()) throw new CliUsageError("Prompt must not be empty");
	const agent = await createAgent();
	let interrupted = false;
	let signalCount = 0;
	const runController = new AbortController();
	const output = createRunOutput(options.format);
	const onSignal = () => {
		interrupted = true;
		signalCount++;
		runController.abort();
		if (signalCount > 1) process.exitCode = 130;
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	let result: RunResult | undefined;
	let cleanupError: unknown;
	try {
		const session = await selectSession(options, agent);
		result = await executeRun(agent, session, prompt, output, runController.signal);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		try {
			await agent.shutdown({ abortRunning: true });
		} catch (error) {
			cleanupError = error;
		}
	}
	if (!result) {
		if (cleanupError) throw cleanupError;
		throw new Error("Run ended without a result");
	}
	output.complete(result, cleanupError);
	return resultExitCode(result, cleanupError, interrupted);
}

function chatHelp(): string {
	return [
		"/help                 Show chat commands",
		"/sessions             List Sessions",
		"/new                  Start a new Session on the next message",
		"/model provider/model Change the current Session model",
		"/thinking level       Change the current Session thinking level",
		"/exit                  Exit chat",
		"Ctrl-C                 Abort the active Run; at the prompt, exit chat",
	].join("\n");
}

async function writeChatBanner(agent: Agent, options: ParsedOptions, session?: SessionSnapshot): Promise<void> {
	const configuration = await agent.getConfiguration();
	const model = session?.model ?? configuration.defaultModel;
	const status = model ? await agent.getProviderStatus(model.providerId) : undefined;
	stderr.write(
		[
			`LoopIQ ${PACKAGE.version}`,
			`Workspace: ${session?.workspaceDir ?? options.workspaceDir}`,
			`Session: ${session?.id ?? "new on first message"}`,
			`Model: ${model ? `${model.providerId}/${model.modelId}` : "not configured"}`,
			`Thinking: ${session?.thinkingLevel ?? configuration.defaultThinkingLevel}`,
			status ? `Credential: ${status.credentialState}` : "Configure with: loopiq config set-model PROVIDER/MODEL",
			model && status?.credentialState === "missing"
				? `Authenticate with: loopiq providers add ${model.providerId}`
				: undefined,
			"Type /help for commands.",
			"",
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
	);
}

async function runChat(options: ParsedOptions): Promise<number> {
	const agent = await createAgent();
	let session: SessionSnapshot | undefined;
	let runController: AbortController | undefined;
	let questionController: AbortController | undefined;
	let exitRequested = false;
	let terminateAfterRun = false;
	let hadFailure = false;
	const onSignal = (signal: NodeJS.Signals) => {
		if (runController) {
			if (signal === "SIGTERM") terminateAfterRun = true;
			runController.abort();
		} else {
			exitRequested = true;
			questionController?.abort();
		}
	};
	const onSigint = () => onSignal("SIGINT");
	const onSigterm = () => onSignal("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	const readline = createInterface({ input: stdin, output: stderr });
	try {
		if (options.sessionId || options.continueSession) session = await selectSession(options, agent);
		await writeChatBanner(agent, options, session);
		let nextInput = options.prompt;
		while (!exitRequested) {
			if (nextInput === undefined) {
				questionController = new AbortController();
				try {
					nextInput = await readline.question("> ", { signal: questionController.signal });
				} catch (error) {
					if (questionController.signal.aborted) break;
					throw error;
				} finally {
					questionController = undefined;
				}
			}
			const input = nextInput.trim();
			nextInput = undefined;
			if (!input) continue;
			if (input === "/exit") break;
			if (input === "/help") {
				stderr.write(`${chatHelp()}\n`);
				continue;
			}
			if (input === "/sessions") {
				stderr.write(`${formatSessions(await agent.listSessions())}\n`);
				continue;
			}
			if (input === "/new") {
				if (session) await agent.closeSession(session.id);
				session = undefined;
				options.sessionId = undefined;
				options.continueSession = false;
				stderr.write("A new Session will be created for the next message.\n");
				continue;
			}
			if (input.startsWith("/model ")) {
				try {
					session ??= await selectSession(options, agent);
					session = await agent.updateSession(session.id, { model: parseModelReference(input.slice(7).trim()) });
					stderr.write(`Model: ${session.model.providerId}/${session.model.modelId}\n`);
				} catch (error) {
					stderr.write(`Error: ${errorDetails(error).message}\n`);
				}
				continue;
			}
			if (input.startsWith("/thinking ")) {
				try {
					const level = input.slice(10).trim();
					if (!isThinkingLevel(level)) throw new CliUsageError("Invalid thinking level");
					session ??= await selectSession(options, agent);
					session = await agent.updateSession(session.id, { thinkingLevel: level });
					stderr.write(`Thinking: ${session.thinkingLevel}\n`);
				} catch (error) {
					stderr.write(`Error: ${errorDetails(error).message}\n`);
				}
				continue;
			}
			if (input.startsWith("/")) {
				stderr.write(`Unknown chat command ${input.split(/\s/, 1)[0]}. Type /help.\n`);
				continue;
			}

			try {
				session ??= await selectSession(options, agent);
				const output = createRunOutput("text");
				runController = new AbortController();
				let result: RunResult;
				try {
					result = await executeRun(agent, session, input, output, runController.signal);
				} finally {
					runController = undefined;
				}
				output.complete(result);
				if (resultExitCode(result) !== 0) hadFailure = true;
			} catch (error) {
				hadFailure = true;
				stderr.write(`Error: ${errorDetails(error).message}\n`);
			}
			if (terminateAfterRun) break;
		}
		return hadFailure ? 1 : 0;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
		readline.close();
		await agent.shutdown({ abortRunning: true });
	}
}

export function createTerminalInteraction(token?: string, signal?: AbortSignal): ProviderLoginInteraction {
	let tokenUsed = false;
	return {
		signal,
		async prompt(prompt) {
			if (token !== undefined) {
				if (prompt.type !== "secret" || tokenUsed) {
					throw new Error("API-token setup requested unsupported additional input");
				}
				tokenUsed = true;
				return token;
			}
			if (prompt.type === "secret") return readSecret(`${prompt.message} `, prompt.signal);
			const readline = createInterface({ input: stdin, output: stderr });
			try {
				if (prompt.type === "select") {
					for (const option of prompt.options) stderr.write(`${option.id}: ${option.label}\n`);
				}
				return await readline.question(`${prompt.message} `, { signal: prompt.signal });
			} finally {
				readline.close();
			}
		},
		notify(event) {
			if (event.type === "auth_url") stderr.write(`${event.instructions ?? "Open"}: ${event.url}\n`);
			else if (event.type === "device_code") {
				stderr.write(`Open ${event.verificationUri} and enter code ${event.userCode}\n`);
			} else stderr.write(`${event.message}\n`);
		},
	};
}

async function readSecret(message: string, signal?: AbortSignal): Promise<string> {
	if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
		const readline = createInterface({ input: stdin, output: stderr });
		try {
			return await readline.question(message, { signal });
		} finally {
			readline.close();
		}
	}

	stderr.write(message);
	const wasRaw = stdin.isRaw;
	const wasPaused = stdin.isPaused();
	return new Promise<string>((resolvePromise, reject) => {
		let value = "";
		let settled = false;
		const cleanup = () => {
			stdin.off("data", onData);
			signal?.removeEventListener("abort", onAbort);
			if (!wasRaw) stdin.setRawMode(false);
			if (wasPaused) stdin.pause();
		};
		const finish = (result: { value: string } | { error: Error }) => {
			if (settled) return;
			settled = true;
			cleanup();
			stderr.write("\n");
			if ("value" in result) resolvePromise(result.value);
			else reject(result.error);
		};
		const onAbort = () => finish({ error: new Error("Credential prompt canceled") });
		const onData = (chunk: string | Buffer) => {
			for (const character of chunk.toString()) {
				if (character === "\r" || character === "\n") {
					finish({ value });
					return;
				}
				if (character === "\u0003") {
					finish({ error: new Error("Credential prompt canceled") });
					return;
				}
				if (character === "\b" || character === "\u007f") value = Array.from(value).slice(0, -1).join("");
				else if (character >= " ") value += character;
			}
		};

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

function renderTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
	);
	return [headers, ...rows]
		.map((row) =>
			row
				.map((value, index) => value.padEnd(widths[index]!))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

function formatSessions(sessions: SessionSummary[]): string {
	if (sessions.length === 0) return "No Sessions.";
	return renderTable(
		["SESSION", "STATE", "UPDATED", "WORKSPACE"],
		sessions.map((session) => [session.id, session.loadedState, session.updatedAt, session.workspaceDir]),
	);
}

function formatProviders(providers: ProviderSummary[]): string {
	return renderTable(
		["PROVIDER", "CREDENTIAL", "AUTH METHODS"],
		providers.map((provider) => [provider.providerId, provider.credentialState, provider.authMethods.join(",")]),
	);
}

function formatModels(models: ModelSummary[]): string {
	if (models.length === 0) return "No configured Provider models.";
	return renderTable(
		["MODEL", "CONTEXT", "MAX OUTPUT", "REASONING"],
		models.map((model) => [
			`${model.providerId}/${model.modelId}`,
			String(model.contextWindow),
			String(model.maxTokens),
			model.reasoning ? "yes" : "no",
		]),
	);
}

function formatConfiguration(configuration: AgentConfiguration): string {
	return JSON.stringify(configuration, null, 2);
}

function writeManagementValue(command: Command, value: unknown, format: OutputFormat): void {
	if (format === "json") {
		stdout.write(`${JSON.stringify(value)}\n`);
		return;
	}
	if (command === "sessions-list") stdout.write(`${formatSessions(value as SessionSummary[])}\n`);
	else if (command === "providers-list") stdout.write(`${formatProviders(value as ProviderSummary[])}\n`);
	else if (command === "models-list") stdout.write(`${formatModels(value as ModelSummary[])}\n`);
	else if (command === "config-get" || command.startsWith("config-set-")) {
		stdout.write(`${formatConfiguration(value as AgentConfiguration)}\n`);
	} else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function runManagementCommand(options: ParsedOptions): Promise<number> {
	const token = options.tokenStdin
		? (await readLimitedStdin(MAX_TOKEN_BYTES, "API token")).replace(/[\r\n]+$/, "")
		: undefined;
	if (options.tokenStdin && !token) throw new CliUsageError("API token must not be empty");
	const agent = await createAgent();
	const authController = new AbortController();
	const onSignal = () => authController.abort();
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		let value: unknown;
		if (options.command === "sessions-list") value = await agent.listSessions();
		else if (options.command === "sessions-delete") {
			await agent.deleteSession(options.target!);
			value = { deleted: options.target };
		} else if (options.command === "providers-list") value = await agent.listProviders();
		else if (options.command === "providers-validate")
			value = await agent.validateProviderCredential(options.target!);
		else if (options.command === "providers-add") {
			const providers = await agent.listProviders();
			const provider = providers.find((candidate) => candidate.providerId === options.target);
			if (!provider) throw new CliUsageError(`Unsupported provider ${options.target}`);
			const method = options.authMethod ?? (provider.authMethods.length === 1 ? provider.authMethods[0] : undefined);
			if (!method) throw new CliUsageError(`--auth-method is required: ${provider.authMethods.join(", ")}`);
			value = await agent.addProviderCredential(provider.providerId, {
				method,
				interaction: createTerminalInteraction(token, authController.signal),
			});
		} else if (options.command === "providers-remove") {
			await agent.removeProviderCredential(options.target!);
			value = { removed: options.target };
		} else if (options.command === "models-list") {
			value = await agent.listModels(options.target, { refresh: options.refresh });
		} else if (options.command === "config-get") value = await agent.getConfiguration();
		else if (options.command === "config-set-model") {
			value = await agent.updateConfiguration({ defaultModel: parseModelReference(options.target!) });
		} else if (options.command === "config-set-thinking") {
			if (!isThinkingLevel(options.target!)) throw new CliUsageError("Invalid thinking level");
			value = await agent.updateConfiguration({ defaultThinkingLevel: options.target as ThinkingLevel });
		} else if (options.command === "config-set-provider-request") {
			value = await agent.updateConfiguration({ providerRequest: options.providerRequest });
		} else throw new Error(`Unsupported management command ${options.command}`);

		writeManagementValue(options.command, value, options.format);
		return 0;
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await agent.shutdown({ abortRunning: true });
	}
}

function helpText(): string {
	return `LoopIQ Agent CLI

Usage:
  loopiq --help
  loopiq --version [--format text|json]
  loopiq run <prompt> [--workspace DIR] [--model PROVIDER/MODEL] [--thinking LEVEL]
  loopiq run --stdin [--format text|json|jsonl]
  loopiq chat [initial prompt] [--workspace DIR]
  loopiq chat --session ID
  loopiq chat --continue [--workspace DIR]
  loopiq sessions list [--format text|json]
  loopiq sessions delete ID
  loopiq providers list [--format text|json]
  loopiq providers add ID [--auth-method api_token|oauth] [--token-stdin]
  loopiq providers validate ID
  loopiq providers remove ID
  loopiq models list [PROVIDER] [--refresh] [--format text|json]
  loopiq config get
  loopiq config set-model PROVIDER/MODEL
  loopiq config set-thinking LEVEL
  loopiq config set-provider-request [request options]

Run is non-interactive and creates a fresh Session unless --session or --continue is used.
Use -- to submit prompt text beginning with a dash.`;
}

function requestedFormat(argv: string[]): OutputFormat {
	const index = argv.indexOf("--format");
	const value = index >= 0 ? argv[index + 1] : undefined;
	return value === "json" || value === "jsonl" ? value : "text";
}

function commandErrorRecord(error: unknown): Record<string, unknown> {
	const details = errorDetails(error);
	return eventRecord("command_failed", {
		phase: error instanceof CliUsageError ? "usage" : "setup_or_execution",
		error: details,
	});
}

function errorExitCode(error: unknown): number {
	if (error instanceof CliUsageError) return 2;
	if (!(error instanceof AgentRuntimeError)) return 1;
	if (error.code === "session_locked" || error.code === "session") return 4;
	if (error.code.startsWith("provider_") || error.code === "credential_store") return 3;
	return 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	try {
		const options = parseArgs(argv);
		if (options.command === "help") {
			stdout.write(`${helpText()}\n`);
			return 0;
		}
		if (options.command === "version") {
			const version = {
				name: "loopiq",
				version: PACKAGE.version,
				revision: process.env.LOOPIQ_BUILD_REVISION || "unknown",
				eventSchema: { name: CLI_EVENT_SCHEMA, version: CLI_EVENT_SCHEMA_VERSION },
			};
			stdout.write(options.format === "json" ? `${JSON.stringify(version)}\n` : `loopiq ${PACKAGE.version}\n`);
			return 0;
		}
		if (options.command === "run") return await runOnce(options);
		if (options.command === "chat") return await runChat(options);
		return await runManagementCommand(options);
	} catch (error) {
		const format = requestedFormat(argv);
		if (format === "json" || format === "jsonl") stdout.write(`${JSON.stringify(commandErrorRecord(error))}\n`);
		else stderr.write(`${errorDetails(error).message}\n`);
		return errorExitCode(error);
	}
}

const entryPath = process.argv[1];
if (entryPath && realpathSync(entryPath) === fileURLToPath(import.meta.url)) {
	void main().then((code) => {
		process.exitCode = code;
	});
}
