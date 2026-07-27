#!/usr/bin/env node
import { resolve } from "node:path";
import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
	type Agent,
	type AgentEventEnvelope,
	AgentRuntimeError,
	createAgent,
	type ModelReference,
	type ProviderLoginInteraction,
	type ProviderRequestPolicy,
	type RunResult,
	type SessionSnapshot,
	type ThinkingLevel,
} from "@loopiq/agent";

type OutputFormat = "text" | "json" | "jsonl";
type Command =
	| "run"
	| "chat"
	| "sessions-list"
	| "sessions-create"
	| "sessions-delete"
	| "providers-list"
	| "providers-add"
	| "providers-remove"
	| "models-list"
	| "config-get"
	| "config-set-model"
	| "config-set-thinking"
	| "config-set-provider-request";

interface ParsedOptions {
	command: Command;
	prompt?: string;
	sessionId?: string;
	newSession: boolean;
	workspaceDir: string;
	model?: string;
	thinking?: ThinkingLevel;
	format: OutputFormat;
	stdin: boolean;
	target?: string;
	authMethod?: "api_token" | "oauth";
	providerRequest?: Partial<ProviderRequestPolicy>;
}

function takeValue(args: string[], index: number, name: string): string {
	const value = args[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	args.splice(index, 2);
	return value;
}

function takeTarget(args: string[], message: string): string {
	const target = args.shift();
	if (!target || target.startsWith("--")) throw new Error(message);
	return target;
}

function takeInteger(args: string[], index: number, name: string): number {
	const value = Number(takeValue(args, index, name));
	if (!Number.isInteger(value)) throw new Error(`${name} requires an integer`);
	return value;
}

export function parseArgs(argv: string[]): ParsedOptions {
	const args = [...argv];
	let command: Command = "run";
	let target: string | undefined;
	const group = args[0];
	if (group === "chat" || group === "run") {
		command = group;
		args.shift();
	} else if (group === "sessions") {
		args.shift();
		const action = args.shift();
		if (action === "list") command = "sessions-list";
		else if (action === "create") command = "sessions-create";
		else if (action === "delete") {
			command = "sessions-delete";
			target = takeTarget(args, "sessions delete requires a Session ID");
		} else throw new Error("sessions requires list, create, or delete");
	} else if (group === "providers") {
		args.shift();
		const action = args.shift();
		if (action === "list") command = "providers-list";
		else if (action === "add") {
			command = "providers-add";
			target = takeTarget(args, "providers add requires a Provider ID");
		} else if (action === "remove") {
			command = "providers-remove";
			target = takeTarget(args, "providers remove requires a Provider ID");
		} else throw new Error("providers requires list, add, or remove");
	} else if (group === "models") {
		args.shift();
		const action = args.shift();
		if (action !== "list") throw new Error("models requires list");
		command = "models-list";
		if (args[0] && !args[0].startsWith("--")) target = args.shift();
	} else if (group === "config") {
		args.shift();
		const action = args.shift();
		if (action === "get") command = "config-get";
		else if (action === "set-model") {
			command = "config-set-model";
			target = takeTarget(args, "config set-model requires provider/model");
		} else if (action === "set-thinking") {
			command = "config-set-thinking";
			target = takeTarget(args, "config set-thinking requires a thinking level");
		} else if (action === "set-provider-request") command = "config-set-provider-request";
		else throw new Error("config requires get, set-model, set-thinking, or set-provider-request");
	}

	const options: ParsedOptions = {
		command,
		target,
		newSession: false,
		workspaceDir: process.cwd(),
		model: process.env.LOOPIQ_MODEL,
		format: "text",
		stdin: false,
	};
	for (let index = 0; index < args.length; ) {
		const argument = args[index]!;
		if (argument === "--session") options.sessionId = takeValue(args, index, argument);
		else if (argument === "--new") {
			options.newSession = true;
			args.splice(index, 1);
		} else if (argument === "--workspace") options.workspaceDir = resolve(takeValue(args, index, argument));
		else if (argument === "--model") options.model = takeValue(args, index, argument);
		else if (argument === "--thinking") options.thinking = takeValue(args, index, argument) as ThinkingLevel;
		else if (argument === "--format") options.format = takeValue(args, index, argument) as OutputFormat;
		else if (argument === "--auth-method") {
			options.authMethod = takeValue(args, index, argument) as "api_token" | "oauth";
		} else if (argument === "--transport") {
			options.providerRequest ??= {};
			options.providerRequest.transport = takeValue(args, index, argument) as ProviderRequestPolicy["transport"];
		} else if (argument === "--timeout-ms") {
			options.providerRequest ??= {};
			options.providerRequest.timeoutMs = takeInteger(args, index, argument);
		} else if (argument === "--max-retries") {
			options.providerRequest ??= {};
			options.providerRequest.maxRetries = takeInteger(args, index, argument);
		} else if (argument === "--max-retry-delay-ms") {
			options.providerRequest ??= {};
			options.providerRequest.maxRetryDelayMs = takeInteger(args, index, argument);
		} else if (argument === "--cache-retention") {
			options.providerRequest ??= {};
			options.providerRequest.cacheRetention = takeValue(
				args,
				index,
				argument,
			) as ProviderRequestPolicy["cacheRetention"];
		} else if (argument === "--stdin") {
			options.stdin = true;
			args.splice(index, 1);
		} else if (argument.startsWith("--")) throw new Error(`Unknown option ${argument}`);
		else index++;
	}
	if (!(["text", "json", "jsonl"] as string[]).includes(options.format)) throw new Error("Invalid output format");
	if (options.authMethod && options.authMethod !== "api_token" && options.authMethod !== "oauth") {
		throw new Error("--auth-method must be api_token or oauth");
	}
	if (command === "config-set-provider-request" && !options.providerRequest) {
		throw new Error("config set-provider-request requires at least one request option");
	}
	if (options.sessionId && options.newSession) throw new Error("--session and --new are mutually exclusive");
	if (options.stdin && args.length > 0) throw new Error("prompt argument and --stdin are mutually exclusive");
	if (command === "run" || command === "chat") options.prompt = args.join(" ") || undefined;
	return options;
}

function parseModelReference(value: string): ModelReference {
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) throw new Error("Model must use provider/model format");
	return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
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

async function attachRenderer(agent: Agent, sessionId: string, format: OutputFormat): Promise<() => void> {
	if (format === "json") return () => {};
	return agent.subscribe(sessionId, (rawEnvelope) => {
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

function serializeResult(result: RunResult) {
	return {
		...result,
		error: result.error
			? { message: result.error.message, code: "code" in result.error ? result.error.code : "unknown" }
			: undefined,
	};
}

async function selectSession(options: ParsedOptions, agent: Agent): Promise<SessionSnapshot> {
	if (options.sessionId) return agent.getSession(options.sessionId);
	return agent.createSession({
		workspaceDir: options.workspaceDir,
		model: options.model ? parseModelReference(options.model) : undefined,
		thinkingLevel: options.thinking,
	});
}

async function applySessionOverrides(options: ParsedOptions, agent: Agent, session: SessionSnapshot): Promise<void> {
	if (options.sessionId && options.model) {
		const model = parseModelReference(options.model);
		if (session.model.providerId !== model.providerId || session.model.modelId !== model.modelId) {
			await agent.updateSession(session.id, { model });
		}
	}
	if (options.thinking && session.thinkingLevel !== options.thinking) {
		await agent.updateSession(session.id, { thinkingLevel: options.thinking });
	}
}

async function runOnce(options: ParsedOptions): Promise<number> {
	const prompt = options.stdin ? await readStdin() : options.prompt;
	if (!prompt?.trim()) throw new Error("A non-empty prompt or --stdin is required");
	const agent = await createAgent();
	const session = await selectSession(options, agent);
	const unsubscribe = await attachRenderer(agent, session.id, options.format);
	await applySessionOverrides(options, agent, session);
	const handle = await agent.run(session.id, { text: prompt });
	let interrupted = false;
	const onSignal = () => {
		if (interrupted) process.exit(130);
		interrupted = true;
		void agent.abort(session.id, handle.runId);
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
		await agent.shutdown();
	}
}

async function runChat(options: ParsedOptions): Promise<number> {
	const agent = await createAgent();
	const session = await selectSession(options, agent);
	await applySessionOverrides(options, agent, session);
	const unsubscribe = await attachRenderer(agent, session.id, options.format);
	const readline = createInterface({ input: stdin, output: stderr });
	try {
		while (true) {
			const input = await readline.question("> ");
			if (!input || input === "/exit") break;
			const result = await (await agent.run(session.id, { text: input })).result;
			if (options.format === "json") stdout.write(`${JSON.stringify(serializeResult(result))}\n`);
			else if (options.format === "text") stdout.write("\n");
		}
		return 0;
	} finally {
		readline.close();
		unsubscribe();
		await agent.shutdown({ abortRunning: true });
	}
}

function createTerminalInteraction(): ProviderLoginInteraction {
	return {
		async prompt(prompt) {
			if (prompt.type === "secret") return readSecret(`${prompt.message} `, prompt.signal);
			const readline = createInterface({ input: stdin, output: stderr });
			try {
				if (prompt.type === "select") {
					for (const option of prompt.options) stderr.write(`${option.id}: ${option.label}\n`);
				}
				return readline.question(`${prompt.message} `, { signal: prompt.signal });
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
	return new Promise<string>((resolve, reject) => {
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
			if ("value" in result) resolve(result.value);
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

async function runManagementCommand(options: ParsedOptions): Promise<number> {
	const agent = await createAgent();
	try {
		let value: unknown;
		if (options.command === "sessions-list") value = await agent.listSessions();
		else if (options.command === "sessions-create") value = await selectSession(options, agent);
		else if (options.command === "sessions-delete") {
			await agent.deleteSession(options.target!);
			value = { deleted: options.target };
		} else if (options.command === "providers-list") {
			value = await agent.listProviders({ validateCredentials: true });
		} else if (options.command === "providers-add") {
			const providers = await agent.listProviders();
			const provider = providers.find((candidate) => candidate.providerId === options.target);
			if (!provider) throw new Error(`Unsupported provider ${options.target}`);
			const method = options.authMethod ?? (provider.authMethods.length === 1 ? provider.authMethods[0] : undefined);
			if (!method) throw new Error(`--auth-method is required: ${provider.authMethods.join(", ")}`);
			value = await agent.addProviderCredential(provider.providerId, {
				method,
				interaction: createTerminalInteraction(),
			});
		} else if (options.command === "providers-remove") {
			await agent.removeProviderCredential(options.target!);
			value = { removed: options.target };
		} else if (options.command === "models-list") value = await agent.listModels(options.target);
		else if (options.command === "config-get") value = await agent.getConfiguration();
		else if (options.command === "config-set-model") {
			value = await agent.updateConfiguration({ defaultModel: parseModelReference(options.target!) });
		} else if (options.command === "config-set-thinking") {
			value = await agent.updateConfiguration({ defaultThinkingLevel: options.target as ThinkingLevel });
		} else if (options.command === "config-set-provider-request") {
			value = await agent.updateConfiguration({ providerRequest: options.providerRequest });
		} else throw new Error(`Unsupported management command ${options.command}`);

		if (options.format === "text") {
			if (Array.isArray(value)) {
				for (const entry of value) stdout.write(`${JSON.stringify(entry)}\n`);
			} else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		} else stdout.write(`${JSON.stringify(value)}\n`);
		return 0;
	} finally {
		await agent.shutdown();
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const options = parseArgs(argv);
	if (options.command === "run") return runOnce(options);
	if (options.command === "chat") return runChat(options);
	return runManagementCommand(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode =
				error instanceof AgentRuntimeError
					? error.code === "session_locked" || error.code === "session"
						? 4
						: error.code.startsWith("provider_") || error.code === "credential_store"
							? 3
							: 1
					: 2;
		});
}
