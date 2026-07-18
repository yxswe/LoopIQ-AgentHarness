import type { UserMessage } from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";
import type { QueueMode } from "../base/options.ts";
import { normalizeHookError } from "../base/types.ts";

export class MessageQueues {
	private steerQueue: UserMessage[] = [];
	private followUpQueue: UserMessage[] = [];
	private nextTurnQueue: AgentMessage[] = [];

	enqueueSteer(message: UserMessage): void {
		this.steerQueue.push(message);
	}

	enqueueFollowUp(message: UserMessage): void {
		this.followUpQueue.push(message);
	}

	enqueueNextTurn(message: AgentMessage): void {
		this.nextTurnQueue.push(message);
	}

	drainSteer(mode: QueueMode, onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		return this.drain(this.steerQueue, mode, onDrained);
	}

	drainFollowUp(mode: QueueMode, onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		return this.drain(this.followUpQueue, mode, onDrained);
	}

	async takeNextTurn(onDrained?: () => Promise<void>): Promise<AgentMessage[]> {
		const messages = this.nextTurnQueue.splice(0);
		if (messages.length === 0) return messages;
		try {
			await onDrained?.();
			return messages;
		} catch (error) {
			this.nextTurnQueue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}

	clearForAbort(): { clearedSteer: UserMessage[]; clearedFollowUp: UserMessage[] } {
		const clearedSteer = [...this.steerQueue];
		const clearedFollowUp = [...this.followUpQueue];
		this.steerQueue = [];
		this.followUpQueue = [];
		return { clearedSteer, clearedFollowUp };
	}

	snapshot(): { steer: UserMessage[]; followUp: UserMessage[]; nextTurn: AgentMessage[] } {
		return {
			steer: [...this.steerQueue],
			followUp: [...this.followUpQueue],
			nextTurn: [...this.nextTurnQueue],
		};
	}

	private async drain(
		queue: UserMessage[],
		mode: QueueMode,
		onDrained?: () => Promise<void>,
	): Promise<AgentMessage[]> {
		const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
		if (messages.length === 0) return messages;
		try {
			await onDrained?.();
			return messages;
		} catch (error) {
			queue.unshift(...messages);
			throw normalizeHookError(error);
		}
	}
}
