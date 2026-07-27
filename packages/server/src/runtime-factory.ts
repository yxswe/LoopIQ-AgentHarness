import { type Agent, createAgent, type ModelReference } from "@loopiq/agent";

export interface CreateDevRuntimeOptions {
	workspaceDir: string;
	defaultModel?: ModelReference;
}

export interface DevRuntime {
	agent: Agent;
	defaultSessionId: string;
	model: ModelReference;
}

export async function createDefaultRuntime(options: CreateDevRuntimeOptions): Promise<DevRuntime> {
	const agent = await createAgent();
	if (options.defaultModel) await agent.updateConfiguration({ defaultModel: options.defaultModel });
	const configuration = await agent.getConfiguration();
	const existing = await agent.listSessions();
	const matchingSession = existing.find((session) => session.workspaceDir === options.workspaceDir);
	const defaultSession = matchingSession
		? await agent.getSession(matchingSession.id)
		: await agent.createSession({ workspaceDir: options.workspaceDir, model: configuration.defaultModel });
	return { agent, defaultSessionId: defaultSession.id, model: defaultSession.model };
}
