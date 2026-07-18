import type { ImageContent, TextContent } from "@loopiq/ai";
import { type AgentMessage, createCompactionSummaryMessage, createCustomMessage } from "../base/messages.ts";
import type {
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	MessageEntry,
	SessionEntry,
	SessionMetadata,
	SessionStorage,
} from "../base/session-types.ts";

export interface SessionContext {
	messages: AgentMessage[];
}

export function buildSessionContext(entries: SessionEntry[]): SessionContext {
	let compaction: CompactionEntry | null = null;

	for (const entry of entries) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message as AgentMessage);
		} else if (entry.type === "custom_message") {
			messages.push(
				createCustomMessage(
					entry.customType,
					entry.content as string | (TextContent | ImageContent)[],
					entry.display,
					entry.details,
					entry.timestamp,
				),
			);
		}
	};

	if (compaction) {
		messages.push(createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp));
		const compactionIdx = entries.findIndex((entry) => entry.type === "compaction" && entry.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = entries[i]!;
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendMessage(entry);
		}
		for (let i = compactionIdx + 1; i < entries.length; i++) {
			appendMessage(entries[i]!);
		}
	} else {
		for (const entry of entries) {
			appendMessage(entry);
		}
	}

	return { messages };
}

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
	private storage: SessionStorage<TMetadata>;

	constructor(storage: SessionStorage<TMetadata>) {
		this.storage = storage;
	}

	getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	getStorage(): SessionStorage<TMetadata> {
		return this.storage;
	}

	getEntries(): Promise<SessionEntry[]> {
		return this.storage.getEntries();
	}

	async buildContext(): Promise<SessionContext> {
		return buildSessionContext(await this.getEntries());
	}

	private async appendTypedEntry<TEntry extends SessionEntry>(entry: TEntry): Promise<string> {
		await this.storage.appendEntry(entry);
		return entry.id;
	}

	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendTypedEntry({
			type: "message",
			id: await this.storage.createEntryId(),
			timestamp: new Date().toISOString(),
			message,
		} satisfies MessageEntry);
	}

	async appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "compaction",
			id: await this.storage.createEntryId(),
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromHook,
		} satisfies CompactionEntry<T>);
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendTypedEntry({
			type: "custom",
			id: await this.storage.createEntryId(),
			timestamp: new Date().toISOString(),
			customType,
			data,
		} satisfies CustomEntry);
	}

	async appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): Promise<string> {
		return this.appendTypedEntry({
			type: "custom_message",
			id: await this.storage.createEntryId(),
			timestamp: new Date().toISOString(),
			customType,
			content,
			display,
			details,
		} satisfies CustomMessageEntry<T>);
	}
}
