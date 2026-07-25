import { type Agent, createAgent, type ModelReference } from "@loopiq/agent";

export interface CreateDevRuntimeOptions {
	dataDir: string;
	cwd: string;
	defaultModel?: ModelReference;
}

export interface DevRuntime {
	agent: Agent;
	defaultSessionId: string;
	model: ModelReference;
}

export async function createDefaultRuntime(options: CreateDevRuntimeOptions): Promise<DevRuntime> {
	const agent = await createAgent({ dataDir: options.dataDir });
	if (options.defaultModel) await agent.updateConfiguration({ defaultModel: options.defaultModel });
	const configuration = await agent.getConfiguration();
	const existing = await agent.listSessions();
	const defaultSession = existing[0]
		? await agent.getSession(existing[0].id)
		: await agent.createSession({ cwd: options.cwd, model: configuration.defaultModel });
	return { agent, defaultSessionId: defaultSession.id, model: defaultSession.model };
}
