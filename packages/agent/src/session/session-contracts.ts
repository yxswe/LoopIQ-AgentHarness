import type { AssistantMessage } from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";
import type { ModelReference, ThinkingLevel } from "../base/options.ts";

export type SessionState = "idle" | "running" | "settling" | "closing" | "closed";

export type RunResult = {
	sessionId: string;
	runId: string;
	status: "completed" | "aborted" | "failed";
	messages: AgentMessage[];
	finalMessage?: AssistantMessage;
	error?: Error;
};

export type RunHandle = {
	sessionId: string;
	runId: string;
	result: Promise<RunResult>;
};

export type SteerOptions = {
	interruptCurrentInference?: boolean;
};

export type AbortResult = {
	clearedSteering: AgentMessage[];
};

export type SessionSnapshot = {
	id: string;
	workspaceDir: string;
	state: SessionState;
	currentRunId?: string;
	model: ModelReference;
	thinkingLevel: ThinkingLevel;
};

export type CreateSessionOptions = {
	workspaceDir: string;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
};

export type UpdateSessionOptions = {
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
};

export type SessionSummary = {
	id: string;
	workspaceDir: string;
	createdAt: string;
	updatedAt: string;
	loadedState: "unloaded" | SessionState;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
};
