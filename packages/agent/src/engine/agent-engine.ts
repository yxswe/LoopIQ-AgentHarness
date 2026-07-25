import type { Models } from "@loopiq/ai";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import { AgentRun, type AgentRunInput } from "./agent-run.ts";
import type { AgentRunOutcome } from "./agent-run-outcome.ts";
import type { AgentRunPort } from "./agent-run-port.ts";

export interface AgentEngineDependencies {
	models: Pick<Models, "streamSimple">;
}

export interface AgentEngine {
	run<
		TSkill extends Skill = Skill,
		TPromptTemplate extends PromptTemplate = PromptTemplate,
		TTool extends AgentTool = AgentTool,
	>(
		input: AgentRunInput<TSkill, TPromptTemplate, TTool>,
		port: AgentRunPort<TSkill, TPromptTemplate, TTool>,
	): Promise<AgentRunOutcome>;
}

export function createAgentEngine(dependencies: AgentEngineDependencies): AgentEngine {
	return {
		run: (input, port) => new AgentRun(dependencies.models, input, port).execute(),
	};
}
