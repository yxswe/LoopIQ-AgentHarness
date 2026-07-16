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
			} else if (write.type === "custom") {
				await this.session.appendCustomEntry(write.customType, write.data);
			} else if (write.type === "custom_message") {
				await this.session.appendCustomMessageEntry(write.customType, write.content, write.display, write.details);
			}
			this.pending.shift();
		}
	}
}
