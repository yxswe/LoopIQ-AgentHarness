import type { UserMessage } from "@loopiq/ai";
import type { AfterProviderResponseEvent, AgentRunEvent, SavePointEvent } from "../base/events.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { TurnState } from "./turn-state.ts";

export type AgentEngineEvent = AgentRunEvent | SavePointEvent | AfterProviderResponseEvent;

export interface AgentRunPort {
	drainSteering(): Promise<AgentMessage[]>;
	commitMessage(message: AgentMessage): Promise<void>;
	commitCompaction(input: {
		sourceMessageCount: number;
		compactedMessageCount: number;
		summary: UserMessage;
	}): Promise<void>;
	flushPendingSessionState(): Promise<boolean>;
	createTurnSnapshot(): TurnState;
	emit(event: AgentEngineEvent): Promise<void>;
}
