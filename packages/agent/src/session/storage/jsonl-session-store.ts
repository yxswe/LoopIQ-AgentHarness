import type { FileError, FileSystem } from "../../base/env.ts";
import type { AgentMessage } from "../../base/messages.ts";
import type { SessionConfiguration } from "../../base/options.ts";
import { type Result, SessionError, toError } from "../../base/types.ts";
import { uuidv7 } from "../uuid.ts";

type SessionStoreFileSystem = Pick<FileSystem, "readTextFile" | "writeFile" | "appendFile">;

type SessionEntryBase = {
	id: string;
	timestamp: string;
};

type MessageEntry = SessionEntryBase & {
	type: "message";
	message: AgentMessage;
};

type SessionConfigurationEntry = SessionEntryBase & {
	type: "session_config";
	configuration: SessionConfiguration;
};

type SessionEntry = MessageEntry | SessionConfigurationEntry;

type SessionEntryInput = Omit<MessageEntry, "id" | "timestamp"> | Omit<SessionConfigurationEntry, "id" | "timestamp">;

type SessionHeader = {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
};

type SessionStoreMetadata = {
	id: string;
	createdAt: string;
	cwd: string;
	path: string;
};

function getFileResultOrThrow<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = uuidv7();
		if (!byId.has(id)) return id;
	}
	return uuidv7();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function invalidSession(filePath: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid JSONL session file ${filePath}: ${message}`, cause);
}

function invalidEntry(filePath: string, lineNumber: number, message: string, cause?: Error): SessionError {
	return new SessionError(
		"invalid_entry",
		`Invalid JSONL session file ${filePath}: line ${lineNumber} ${message}`,
		cause,
	);
}

function parseHeaderLine(line: string, filePath: string): SessionHeader {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidSession(filePath, "first line is not a valid session header", toError(error));
	}
	if (!isRecord(parsed) || parsed.type !== "session") {
		throw invalidSession(filePath, "first line is not a valid session header");
	}
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof parsed.cwd !== "string" || !parsed.cwd) throw invalidSession(filePath, "session header is missing cwd");
	return { type: "session", id: parsed.id, timestamp: parsed.timestamp, cwd: parsed.cwd };
}

function isSessionConfiguration(value: unknown): value is SessionConfiguration {
	if (!isRecord(value) || !isRecord(value.model)) return false;
	return (
		typeof value.model.providerId === "string" &&
		value.model.providerId.length > 0 &&
		typeof value.model.modelId === "string" &&
		value.model.modelId.length > 0 &&
		typeof value.thinkingLevel === "string" &&
		["off", "minimal", "low", "medium", "high", "xhigh"].includes(value.thinkingLevel)
	);
}

function validateEntry(parsed: unknown, filePath: string, lineNumber: number): SessionEntry {
	if (!isRecord(parsed)) throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	switch (parsed.type) {
		case "message":
			if (!isRecord(parsed.message) || typeof parsed.message.role !== "string") {
				throw invalidEntry(filePath, lineNumber, "has an invalid message");
			}
			break;
		case "session_config":
			if (!isSessionConfiguration(parsed.configuration)) {
				throw invalidEntry(filePath, lineNumber, "has an invalid Session configuration");
			}
			break;
		default:
			throw invalidEntry(filePath, lineNumber, `has unsupported entry type ${String(parsed.type)}`);
	}
	return parsed as unknown as SessionEntry;
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw invalidEntry(filePath, lineNumber, "is not valid JSON", toError(error));
	}
	return validateEntry(parsed, filePath, lineNumber);
}

function metadataFromHeader(header: SessionHeader, path: string): SessionStoreMetadata {
	return { id: header.id, createdAt: header.timestamp, cwd: header.cwd, path };
}

async function readStoreFile(
	fs: SessionStoreFileSystem,
	filePath: string,
): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
	const content = getFileResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(filePath, "missing session header");

	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	for (let index = 1; index < lines.length; index++) {
		const entry = parseEntryLine(lines[index]!, filePath, index + 1);
		if (ids.has(entry.id)) throw invalidEntry(filePath, index + 1, `duplicates entry id ${entry.id}`);
		ids.add(entry.id);
		entries.push(entry);
	}
	return { header, entries };
}

/** The single durable Session store. It owns JSONL parsing, validation, ordering, and serialized appends. */
export class JsonlSessionStore {
	readonly metadata: SessionStoreMetadata;
	private readonly fs: SessionStoreFileSystem;
	private readonly entries: SessionEntry[];
	private readonly byId: Map<string, SessionEntry>;
	private appendQueue: Promise<void> = Promise.resolve();

	private constructor(fs: SessionStoreFileSystem, filePath: string, header: SessionHeader, entries: SessionEntry[]) {
		this.fs = fs;
		this.metadata = metadataFromHeader(header, filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
	}

	static async readMetadata(fs: SessionStoreFileSystem, filePath: string): Promise<SessionStoreMetadata> {
		const content = getFileResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
		const firstLine = content.split("\n").find((line) => line.trim());
		if (!firstLine) throw invalidSession(filePath, "missing session header");
		return metadataFromHeader(parseHeaderLine(firstLine, filePath), filePath);
	}

	static async open(fs: SessionStoreFileSystem, filePath: string): Promise<JsonlSessionStore> {
		const loaded = await readStoreFile(fs, filePath);
		return new JsonlSessionStore(fs, filePath, loaded.header, loaded.entries);
	}

	static async create(
		fs: SessionStoreFileSystem,
		filePath: string,
		options: { cwd: string; sessionId: string },
	): Promise<JsonlSessionStore> {
		const header: SessionHeader = {
			type: "session",
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
		};
		getFileResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStore(fs, filePath, header, []);
	}

	restore(): { messages: AgentMessage[]; configuration?: SessionConfiguration } {
		const messages: AgentMessage[] = [];
		let configuration: SessionConfiguration | undefined;
		for (const entry of this.entries) {
			if (entry.type === "message") messages.push(entry.message);
			else {
				configuration = {
					model: { ...entry.configuration.model },
					thinkingLevel: entry.configuration.thinkingLevel,
				};
			}
		}
		return { messages, configuration };
	}

	appendMessage(message: AgentMessage): Promise<void> {
		return this.appendEntry({ type: "message", message } satisfies Omit<MessageEntry, "id" | "timestamp">);
	}

	appendConfiguration(configuration: SessionConfiguration): Promise<void> {
		return this.appendEntry({
			type: "session_config",
			configuration: {
				model: { ...configuration.model },
				thinkingLevel: configuration.thinkingLevel,
			},
		} satisfies Omit<SessionConfigurationEntry, "id" | "timestamp">);
	}

	private appendEntry(entry: SessionEntryInput): Promise<void> {
		const operation = this.appendQueue.then(async () => {
			const complete = {
				...entry,
				id: generateEntryId(this.byId),
				timestamp: new Date().toISOString(),
			} as SessionEntry;
			validateEntry(complete, this.metadata.path, this.entries.length + 2);
			getFileResultOrThrow(
				await this.fs.appendFile(this.metadata.path, `${JSON.stringify(complete)}\n`),
				`Failed to append session entry ${complete.id}`,
			);
			this.entries.push(complete);
			this.byId.set(complete.id, complete);
		});
		this.appendQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
}
