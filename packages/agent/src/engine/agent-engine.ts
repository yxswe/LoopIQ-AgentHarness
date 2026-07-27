import { cleanupSessionResources, type Model, type Models } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentSystemPrompt, ModelReference, ProviderRequestPolicy, ThinkingLevel } from "../base/options.ts";
import type { AgentResources, AgentTool } from "../base/resource.ts";
import { AgentRuntimeError } from "../base/types.ts";
import { AgentRun, type AgentRunInput } from "./agent-run.ts";
import type { AgentRunOutcome } from "./agent-run-outcome.ts";
import type { AgentRunPort } from "./agent-run-port.ts";
import { createTurnState, type TurnState } from "./turn-state.ts";

function findDuplicateToolNames(tools: AgentTool[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name)) duplicates.add(tool.name);
		seen.add(tool.name);
	}
	return [...duplicates];
}

/** Shared, Session-stateless execution services used by every loaded AgentSession. */
export class AgentEngine {
	private readonly models: Pick<Models, "getModel" | "streamSimple">;
	private readonly getProviderRequestPolicy: () => ProviderRequestPolicy;
	private readonly createTools?: (env: ExecutionEnv) => AgentTool[] | Promise<AgentTool[]>;
	private readonly resources: AgentResources;
	private readonly systemPrompt?: AgentSystemPrompt;

	constructor(options: {
		models: Pick<Models, "getModel" | "streamSimple">;
		getProviderRequestPolicy(): ProviderRequestPolicy;
		createTools?: (env: ExecutionEnv) => AgentTool[] | Promise<AgentTool[]>;
		resources?: AgentResources;
		systemPrompt?: AgentSystemPrompt;
	}) {
		this.models = options.models;
		this.getProviderRequestPolicy = options.getProviderRequestPolicy;
		this.createTools = options.createTools;
		this.resources = {
			skills: options.resources?.skills?.slice(),
			promptTemplates: options.resources?.promptTemplates?.slice(),
		};
		this.systemPrompt = options.systemPrompt;
	}

	resolveModel(reference: ModelReference): Model<any> {
		const model = this.models.getModel(reference.providerId, reference.modelId);
		if (!model) {
			throw new AgentRuntimeError("model_not_found", `Unknown model ${reference.providerId}/${reference.modelId}`);
		}
		return model;
	}

	async createSessionTools(env: ExecutionEnv): Promise<AgentTool[]> {
		const tools = ((await this.createTools?.(env)) ?? []).slice();
		const duplicates = findDuplicateToolNames(tools);
		if (duplicates.length > 0) {
			throw new AgentRuntimeError("invalid_argument", `Duplicate tool name(s): ${duplicates.join(", ")}`);
		}
		return tools;
	}

	cleanupSession(sessionId: string): void {
		cleanupSessionResources(sessionId);
	}

	createTurnSnapshot(input: {
		sessionId: string;
		env: ExecutionEnv;
		model: Model<any>;
		thinkingLevel: ThinkingLevel;
		tools: AgentTool[];
	}): Promise<TurnState> {
		return createTurnState({
			...input,
			resources: this.resources,
			providerRequestPolicy: this.getProviderRequestPolicy(),
			systemPrompt: this.systemPrompt,
		});
	}

	run(input: AgentRunInput, port: AgentRunPort): Promise<AgentRunOutcome> {
		return new AgentRun(this.models, input, port).execute();
	}
}
