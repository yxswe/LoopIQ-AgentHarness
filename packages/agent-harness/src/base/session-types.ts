import type { ImageContent, TextContent } from "@loopiq/ai";
import type { FileOperations } from "./env.ts";
import type { AgentMessage } from "./messages.ts";

export interface SessionEntryBase {
	type: string;
	id: string;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export type SessionEntry = MessageEntry | CompactionEntry | CustomEntry | CustomMessageEntry;

export interface SessionMetadata {
	id: string;
	createdAt: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	createEntryId(): Promise<string>;
	appendEntry(entry: SessionEntry): Promise<void>;
	getEntries(): Promise<SessionEntry[]>;
}

export type PendingSessionWrite = SessionEntry extends infer TEntry
	? TEntry extends SessionEntry
		? Omit<TEntry, "id" | "timestamp">
		: never
	: never;

export interface AbortResult {
	clearedSteer: AgentMessage[];
	clearedFollowUp: AgentMessage[];
}

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOperations;
	settings: CompactionSettings;
}
