import type { Model, Models } from "@loopiq/ai";
import type { ModelReference, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";
import type { AgentTool } from "../base/resource.ts";
import { AgentRuntimeError } from "../base/types.ts";
import { ContextManager } from "../context/context-manager.ts";
import { SYSTEM_PROMPT } from "../prompts/system-prompt.ts";
import { AgentRun, type AgentRunInput } from "./agent-run.ts";
import type { AgentRunOutcome } from "./agent-run-outcome.ts";
import type { AgentRunPort } from "./agent-run-port.ts";
import type { TurnState } from "./turn-state.ts";

/** Shared, Session-stateless execution services used by every loaded AgentSession. */
export class AgentEngine {
	private readonly models: Pick<Models, "getModel" | "streamSimple">;
	private readonly getProviderRequestPolicy: () => ProviderRequestPolicy;
	private readonly systemPrompt = SYSTEM_PROMPT;
	private readonly contextManager: ContextManager;

	constructor(options: {
		models: Pick<Models, "getModel" | "streamSimple">;
		getProviderRequestPolicy(): ProviderRequestPolicy;
	}) {
		this.models = options.models;
		this.getProviderRequestPolicy = options.getProviderRequestPolicy;
		this.contextManager = new ContextManager(options.models);
	}

	resolveModel(reference: ModelReference): Model<any> {
		const model = this.models.getModel(reference.providerId, reference.modelId);
		if (!model) {
			throw new AgentRuntimeError("model_not_found", `Unknown model ${reference.providerId}/${reference.modelId}`);
		}
		return model;
	}

	createTurnSnapshot(input: { model: Model<any>; thinkingLevel: ThinkingLevel; tools: AgentTool[] }): TurnState {
		return {
			systemPrompt: this.systemPrompt,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			tools: input.tools.slice(),
			providerRequestPolicy: { ...this.getProviderRequestPolicy() },
		};
	}

	run(input: AgentRunInput, port: AgentRunPort): Promise<AgentRunOutcome> {
		return new AgentRun(this.models, this.contextManager, input, port).execute();
	}
}
