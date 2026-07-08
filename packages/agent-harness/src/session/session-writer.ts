import type { PendingSessionWrite, Session } from "../base/session-types.ts";

export class SessionWriter {
	private pending: PendingSessionWrite[] = [];
	private readonly session: Session;

	constructor(session: Session) {
		this.session = session;
	}

	enqueue(write: PendingSessionWrite): void {
		this.pending.push(write);
	}

	hasPending(): boolean {
		return this.pending.length > 0;
	}

	async flush(): Promise<void> {
		while (this.pending.length > 0) {
			const write = this.pending[0]!;
			if (write.type === "message") {
				await this.session.appendMessage(write.message);
			} else if (write.type === "model_change") {
				await this.session.appendModelChange(write.provider, write.modelId);
			} else if (write.type === "thinking_level_change") {
				await this.session.appendThinkingLevelChange(write.thinkingLevel);
			} else if (write.type === "active_tools_change") {
				await this.session.appendActiveToolsChange(write.activeToolNames);
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			} else if (write.type === "label") {
				await this.session.appendLabel(write.targetId, write.label);
			} else if (write.type === "session_info") {
				await this.session.appendSessionName(write.name ?? "");
			} else if (write.type === "leaf") {
				await this.session.getStorage().setLeafId(write.targetId);
			}
			this.pending.shift();
		}
	}
}
