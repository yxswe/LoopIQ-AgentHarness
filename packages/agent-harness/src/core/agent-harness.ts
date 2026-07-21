import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Model } from "@loopiq/ai";
import type { AgentHookEvent, AgentHookEventResultMap, AgentNotificationEvent } from "../base/events.ts";
import type { AgentHarnessOptions, ThinkingLevel } from "../base/options.ts";
import type { AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { AbortResult } from "../base/session-types.ts";
import { AgentHarnessError } from "../base/types.ts";
import { createAgentEngine } from "../engine/agent-engine.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { AgentSession } from "../runtime/agent-session.ts";
import { JsonlSessionStorage } from "../session/jsonl-storage.ts";
import type { Session } from "../session/session.ts";
import { getFileSystemResultOrThrow, toSession } from "../session/storage-utils.ts";

async function openOrCreateSession(env: NodeExecutionEnv, sessionPath: string, cwd: string): Promise<Session> {
	const exists = getFileSystemResultOrThrow(
		await env.exists(sessionPath),
		`Failed to check whether session exists ${sessionPath}`,
	);
	const storage = exists
		? await JsonlSessionStorage.open(env, sessionPath)
		: await JsonlSessionStorage.create(env, sessionPath, { cwd, sessionId: randomUUID() });
	return toSession(storage);
}

/**
 * Backward-compatible single-Session facade. New headless and server callers
 * should use AgentSession and SessionHost directly.
 */
export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	private readonly session: AgentSession<TSkill, TPromptTemplate, TTool>;

	private constructor(session: AgentSession<TSkill, TPromptTemplate, TTool>) {
		this.session = session;
	}

	static async create<
		TSkill extends Skill = Skill,
		TPromptTemplate extends PromptTemplate = PromptTemplate,
		TTool extends AgentTool = AgentTool,
	>(
		options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>,
	): Promise<AgentHarness<TSkill, TPromptTemplate, TTool>> {
		const env = new NodeExecutionEnv({ cwd: options.cwd });
		const session = await openOrCreateSession(env, options.sessionPath, options.cwd);
		const runtime = await AgentSession.create({
			env,
			session,
			engine: createAgentEngine({ models: options.models }),
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			tools: options.tools,
			activeToolNames: options.activeToolNames,
			resources: options.resources,
			systemPrompt: options.systemPrompt,
			streamOptions: options.streamOptions,
			steeringMode: options.steeringMode,
			followUpMode: options.followUpMode,
		});
		return new AgentHarness(runtime);
	}

	async send(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage | undefined> {
		const snapshot = this.session.getSnapshot();
		if (snapshot.state === "idle") {
			const result = await this.session.startRun({ text, images: options?.images }).result;
			if (result.finalMessage) return result.finalMessage;
			throw result.error ?? new AgentHarnessError("unknown", "Agent run failed without an assistant message");
		}
		const runId = snapshot.currentRunId;
		if (!runId) throw new AgentHarnessError("invalid_state", "AgentSession has no active run");
		await this.session.steer(runId, { text, images: options?.images });
	}

	getModel(): Model<any> {
		return this.session.getModel();
	}

	setModel(model: Model<any>): Promise<void> {
		return this.session.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel {
		return this.session.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.session.setThinkingLevel(level);
	}

	abort(): Promise<AbortResult> {
		return this.session.abortCurrent();
	}

	subscribe(
		listener: (event: AgentNotificationEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.session.subscribeLegacy(listener);
	}

	on<TType extends keyof AgentHookEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHookEvent, { type: TType }>,
		) => Promise<AgentHookEventResultMap[TType]> | AgentHookEventResultMap[TType],
	): () => void {
		return this.session.on(type, handler);
	}
}
