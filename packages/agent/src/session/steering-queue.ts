import type { UserMessage } from "@loopiq/ai";

/** AgentSession-owned user messages waiting for the active Run's next safe steering point. */
export class SteeringQueue {
	private messages: UserMessage[] = [];

	enqueue(message: UserMessage): void {
		this.messages.push(message);
	}

	async drainOne(onDrained: () => Promise<void>): Promise<UserMessage[]> {
		const messages = this.messages.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await onDrained();
			return messages;
		} catch (error) {
			this.messages.unshift(...messages);
			throw error;
		}
	}

	clear(): UserMessage[] {
		const messages = this.messages;
		this.messages = [];
		return messages;
	}

	snapshot(): UserMessage[] {
		return [...this.messages];
	}
}
