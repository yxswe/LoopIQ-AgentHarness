import type {
	AfterProviderResponseEvent,
	AgentHookEvent,
	AgentHookEventResultMap,
	AgentRunEvent,
	SavePointEvent,
} from "../base/events.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { TurnState } from "../core/turn-state.ts";

export type AgentEngineEvent = AgentRunEvent | SavePointEvent | AfterProviderResponseEvent;

export interface AgentRunPort<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	takeNextTurn(): Promise<AgentMessage[]>;
	drainSteering(): Promise<AgentMessage[]>;
	drainFollowUp(): Promise<AgentMessage[]>;
	commitMessage(message: AgentMessage): Promise<void>;
	hasPendingWrites(): boolean;
	flushPendingWrites(): Promise<void>;
	createTurnSnapshot(signal: AbortSignal): Promise<TurnState<TSkill, TPromptTemplate, TTool>>;
	emit(event: AgentEngineEvent, signal?: AbortSignal): Promise<void>;
	emitHook<TType extends keyof AgentHookEventResultMap>(
		event: Extract<AgentHookEvent, { type: TType }>,
		signal?: AbortSignal,
	): Promise<AgentHookEventResultMap[TType] | undefined>;
}
