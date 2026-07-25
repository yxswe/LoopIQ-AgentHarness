import type { ThinkingLevel } from "../base/options.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { AgentSession, AgentSessionState } from "./agent-session.ts";
import type { ModelReference } from "./persisted-session-config.ts";

export interface CreateSessionOptions {
	cwd: string;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	createdAt: string;
	updatedAt: string;
	loadedState: "unloaded" | AgentSessionState;
	model?: ModelReference;
	thinkingLevel?: ThinkingLevel;
}

export interface SessionHost<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	create(options: CreateSessionOptions): Promise<AgentSession<TSkill, TPromptTemplate, TTool>>;
	open(sessionId: string): Promise<AgentSession<TSkill, TPromptTemplate, TTool>>;
	list(): Promise<SessionSummary[]>;
	close(sessionId: string): Promise<void>;
	delete(sessionId: string): Promise<void>;
	shutdown(options?: { abortRunning?: boolean }): Promise<void>;
}
