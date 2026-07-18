import type { FileSystem } from "../base/env.ts";
import type { JsonlSessionMetadata, SessionEntry, SessionStorage } from "../base/session-types.ts";
import { SessionError, toError } from "../base/types.ts";
import { getFileSystemResultOrThrow } from "./storage-utils.ts";
import { uuidv7 } from "./uuid.ts";

const SESSION_VERSION = 4;

type JsonlSessionStorageFileSystem = Pick<FileSystem, "readTextFile" | "writeFile" | "appendFile">;

interface SessionHeader {
	type: "session";
	version: typeof SESSION_VERSION;
	id: string;
	timestamp: string;
	cwd: string;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = uuidv7().slice(0, 8);
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
	if (parsed.version !== SESSION_VERSION) {
		throw invalidSession(
			filePath,
			`unsupported session version ${String(parsed.version)}; expected linear session version ${SESSION_VERSION}`,
		);
	}
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidSession(filePath, "session header is missing id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidSession(filePath, "session header is missing timestamp");
	}
	if (typeof parsed.cwd !== "string" || !parsed.cwd) throw invalidSession(filePath, "session header is missing cwd");
	if ("parentSession" in parsed)
		throw invalidSession(filePath, "linear session header must not contain parentSession");
	return {
		type: "session",
		version: SESSION_VERSION,
		id: parsed.id,
		timestamp: parsed.timestamp,
		cwd: parsed.cwd,
	};
}

function validateEntry(parsed: unknown, filePath: string, lineNumber: number): SessionEntry {
	if (!isRecord(parsed)) throw invalidEntry(filePath, lineNumber, "is not a valid session entry");
	if (typeof parsed.id !== "string" || !parsed.id) throw invalidEntry(filePath, lineNumber, "is missing entry id");
	if (typeof parsed.timestamp !== "string" || !parsed.timestamp) {
		throw invalidEntry(filePath, lineNumber, "is missing timestamp");
	}
	if ("parentId" in parsed) throw invalidEntry(filePath, lineNumber, "must not contain parentId");

	switch (parsed.type) {
		case "message":
			if (!isRecord(parsed.message) || typeof parsed.message.role !== "string") {
				throw invalidEntry(filePath, lineNumber, "has an invalid message");
			}
			break;
		case "compaction":
			if (typeof parsed.summary !== "string") {
				throw invalidEntry(filePath, lineNumber, "has an invalid compaction summary");
			}
			if (typeof parsed.firstKeptEntryId !== "string" || !parsed.firstKeptEntryId) {
				throw invalidEntry(filePath, lineNumber, "has an invalid firstKeptEntryId");
			}
			if (typeof parsed.tokensBefore !== "number" || !Number.isFinite(parsed.tokensBefore)) {
				throw invalidEntry(filePath, lineNumber, "has invalid tokensBefore");
			}
			break;
		case "custom":
			if (typeof parsed.customType !== "string" || !parsed.customType) {
				throw invalidEntry(filePath, lineNumber, "has an invalid customType");
			}
			break;
		case "custom_message":
			if (typeof parsed.customType !== "string" || !parsed.customType) {
				throw invalidEntry(filePath, lineNumber, "has an invalid customType");
			}
			if (typeof parsed.content !== "string" && !Array.isArray(parsed.content)) {
				throw invalidEntry(filePath, lineNumber, "has invalid content");
			}
			if (typeof parsed.display !== "boolean") {
				throw invalidEntry(filePath, lineNumber, "has invalid display");
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

function headerToSessionMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
	};
}

async function loadJsonlStorage(
	fs: JsonlSessionStorageFileSystem,
	filePath: string,
): Promise<{ header: SessionHeader; entries: SessionEntry[] }> {
	const content = getFileSystemResultOrThrow(await fs.readTextFile(filePath), `Failed to read session ${filePath}`);
	const lines = content.split("\n").filter((line) => line.trim());
	if (lines.length === 0) throw invalidSession(filePath, "missing session header");

	const header = parseHeaderLine(lines[0]!, filePath);
	const entries: SessionEntry[] = [];
	const ids = new Set<string>();
	for (let index = 1; index < lines.length; index++) {
		const entry = parseEntryLine(lines[index]!, filePath, index + 1);
		if (ids.has(entry.id)) throw invalidEntry(filePath, index + 1, `duplicates entry id ${entry.id}`);
		if (entry.type === "compaction" && !ids.has(entry.firstKeptEntryId)) {
			throw invalidEntry(filePath, index + 1, `references unknown firstKeptEntryId ${entry.firstKeptEntryId}`);
		}
		ids.add(entry.id);
		entries.push(entry);
	}
	return { header, entries };
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly fs: JsonlSessionStorageFileSystem;
	private readonly filePath: string;
	private readonly metadata: JsonlSessionMetadata;
	private readonly entries: SessionEntry[];
	private readonly byId: Map<string, SessionEntry>;

	private constructor(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		header: SessionHeader,
		entries: SessionEntry[],
	) {
		this.fs = fs;
		this.filePath = filePath;
		this.metadata = headerToSessionMetadata(header, this.filePath);
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
	}

	static async open(fs: JsonlSessionStorageFileSystem, filePath: string): Promise<JsonlSessionStorage> {
		const loaded = await loadJsonlStorage(fs, filePath);
		return new JsonlSessionStorage(fs, filePath, loaded.header, loaded.entries);
	}

	static async create(
		fs: JsonlSessionStorageFileSystem,
		filePath: string,
		options: { cwd: string; sessionId: string },
	): Promise<JsonlSessionStorage> {
		const header: SessionHeader = {
			type: "session",
			version: SESSION_VERSION,
			id: options.sessionId,
			timestamp: new Date().toISOString(),
			cwd: options.cwd,
		};
		getFileSystemResultOrThrow(
			await fs.writeFile(filePath, `${JSON.stringify(header)}\n`),
			`Failed to create session ${filePath}`,
		);
		return new JsonlSessionStorage(fs, filePath, header, []);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async createEntryId(): Promise<string> {
		return generateEntryId(this.byId);
	}

	async appendEntry(entry: SessionEntry): Promise<void> {
		validateEntry(entry, this.filePath, this.entries.length + 2);
		if (this.byId.has(entry.id)) {
			throw new SessionError("invalid_entry", `Session entry id ${entry.id} already exists`);
		}
		if (entry.type === "compaction" && !this.byId.has(entry.firstKeptEntryId)) {
			throw new SessionError(
				"invalid_entry",
				`Compaction references unknown firstKeptEntryId ${entry.firstKeptEntryId}`,
			);
		}
		getFileSystemResultOrThrow(
			await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
			`Failed to append session entry ${entry.id}`,
		);
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
	}

	async getEntries(): Promise<SessionEntry[]> {
		return this.entries.slice();
	}
}
