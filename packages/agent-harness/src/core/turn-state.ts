import type { Model } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentContext, AgentHarnessOptions, AgentHarnessStreamOptions, ThinkingLevel } from "../base/options.ts";
import type { AgentHarnessResources, AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { Session } from "../base/session-types.ts";
import { cloneStreamOptions } from "./stream-options.ts";

export interface TurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	messages: AgentMessage[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	sessionId: string;
	systemPrompt: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: TTool[];
	activeTools: TTool[];
}

export async function buildTurnState<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
>(deps: {
	session: Session;
	env: ExecutionEnv;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	tools: Map<string, TTool>;
	activeToolNames: string[];
	resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	streamOptions: AgentHarnessStreamOptions;
	systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
}): Promise<TurnState<TSkill, TPromptTemplate, TTool>> {
	const context = await deps.session.buildContext();
	const sessionMetadata = await deps.session.getMetadata();
	const tools = [...deps.tools.values()];
	const activeTools = deps.activeToolNames
		.map((name) => deps.tools.get(name))
		.filter((tool): tool is TTool => tool !== undefined);
	let systemPrompt = "You are a helpful assistant.";
	if (typeof deps.systemPrompt === "string") {
		systemPrompt = deps.systemPrompt;
	} else if (deps.systemPrompt) {
		systemPrompt = await deps.systemPrompt({
			env: deps.env,
			session: deps.session,
			model: deps.model,
			thinkingLevel: deps.thinkingLevel,
			activeTools,
			resources: deps.resources,
		});
	}
	return {
		messages: context.messages,
		resources: deps.resources,
		streamOptions: cloneStreamOptions(deps.streamOptions),
		sessionId: sessionMetadata.id,
		systemPrompt,
		model: deps.model,
		thinkingLevel: deps.thinkingLevel,
		tools,
		activeTools,
	};
}

export function buildContext(turnState: TurnState, systemPromptOverride?: string): AgentContext {
	return {
		systemPrompt: systemPromptOverride ?? turnState.systemPrompt,
		messages: turnState.messages.slice(),
		tools: turnState.activeTools.slice(),
	};
}
