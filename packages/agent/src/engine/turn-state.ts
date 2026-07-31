import type { Model } from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentContext, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";
import type { AgentTool } from "../base/resource.ts";

export type TurnState = {
	providerRequestPolicy: ProviderRequestPolicy;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
};

export function createAgentContext(turnState: TurnState, messages: AgentMessage[]): AgentContext {
	return {
		systemPrompt: turnState.systemPrompt,
		messages,
		tools: turnState.tools.slice(),
	};
}
