import type { AgentNotificationEvent } from "../base/events.ts";

export interface SerializedRunError {
	code: string;
	message: string;
}

export interface RunSettledEvent {
	type: "run_settled";
	status: "completed" | "aborted" | "failed";
	error?: SerializedRunError;
}

export interface AgentEventEnvelope {
	schemaVersion: 1;
	sessionId: string;
	runtimeId: string;
	runId?: string;
	sequence: number;
	timestamp: string;
	event: AgentNotificationEvent | RunSettledEvent;
}

export type AgentEventListener = (envelope: AgentEventEnvelope) => void | Promise<void>;
