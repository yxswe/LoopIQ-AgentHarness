import type { Model } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentContext, AgentSystemPrompt, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";
import type { AgentResources, AgentTool } from "../base/resource.ts";

export type TurnState = {
	providerRequestPolicy: ProviderRequestPolicy;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
};

export async function createTurnState(input: {
	sessionId: string;
	env: ExecutionEnv;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: AgentTool[];
	resources: AgentResources;
	providerRequestPolicy: ProviderRequestPolicy;
	systemPrompt?: AgentSystemPrompt;
}): Promise<TurnState> {
	let systemPrompt = "You are a helpful assistant.";
	if (typeof input.systemPrompt === "string") {
		systemPrompt = input.systemPrompt;
	} else if (input.systemPrompt) {
		systemPrompt = await input.systemPrompt({
			env: input.env,
			sessionId: input.sessionId,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			tools: input.tools,
			resources: input.resources,
		});
	}
	return {
		providerRequestPolicy: { ...input.providerRequestPolicy },
		systemPrompt,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		tools: input.tools.slice(),
	};
}

export function createAgentContext(turnState: TurnState, messages: AgentMessage[]): AgentContext {
	return {
		systemPrompt: turnState.systemPrompt,
		messages,
		tools: turnState.tools.slice(),
	};
}
