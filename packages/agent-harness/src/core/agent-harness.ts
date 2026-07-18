import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent, Model, Models } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentHookEvent, AgentHookEventResultMap, AgentNotificationEvent } from "../base/events.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { AgentHarnessOptions, AgentHarnessStreamOptions, QueueMode, ThinkingLevel } from "../base/options.ts";
import type { AgentHarnessResources, AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { AbortResult } from "../base/session-types.ts";
import { AgentHarnessError, normalizeHarnessError, toError } from "../base/types.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { formatPromptTemplateInvocation } from "../prompt-templates.ts";
import { MessageQueues } from "../queue/message-queues.ts";
import { JsonlSessionStorage } from "../session/jsonl-storage.ts";
import type { Session } from "../session/session.ts";
import { SessionWriter } from "../session/session-writer.ts";
import { getFileSystemResultOrThrow, toSession } from "../session/storage-utils.ts";
import { formatSkillInvocation } from "../skills/skills.ts";
import { AgentEventBus } from "./event-bus.ts";
import { createUserMessage } from "./message-factory.ts";
import { cloneStreamOptions } from "./stream-options.ts";
import { TurnRunner } from "./turn-runner.ts";
import { buildContext, buildTurnState, type TurnState } from "./turn-state.ts";

function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

type AgentHarnessPhase = "idle" | "turn" | "compaction" | "retry";

/**
 * Resolved construction inputs for {@link AgentHarness}. The public
 * {@link AgentHarnessOptions.cwd}/`sessionPath` are replaced by the concrete
 * `env`/`session` that {@link AgentHarness.create} assembles internally.
 */
type AgentHarnessInit<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> = Omit<AgentHarnessOptions<TSkill, TPromptTemplate, TTool>, "cwd" | "sessionPath"> & {
	env: ExecutionEnv;
	session: Session;
};

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

export class AgentHarness<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	private readonly env: ExecutionEnv;
	private session: Session;
	private sessionWriter!: SessionWriter;
	private readonly models: Models;
	private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private streamOptions: AgentHarnessStreamOptions;
	private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private tools = new Map<string, TTool>();
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private steeringQueueMode: QueueMode;
	private followUpQueueMode: QueueMode;

	private phase: AgentHarnessPhase = "idle";
	private runAbortController?: AbortController;
	private runPromise?: Promise<void>;
	private readonly queues = new MessageQueues();
	private readonly events = new AgentEventBus<TSkill, TPromptTemplate>();

	/**
	 * Create a harness wired to a node execution environment (from `cwd`) and a
	 * JSONL-backed session (from `sessionPath`, opened if present, otherwise
	 * created). This is the single public entry point; the constructor is
	 * internal because session assembly is asynchronous.
	 */
	static async create<
		TSkill extends Skill = Skill,
		TPromptTemplate extends PromptTemplate = PromptTemplate,
		TTool extends AgentTool = AgentTool,
	>(
		options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>,
	): Promise<AgentHarness<TSkill, TPromptTemplate, TTool>> {
		const { cwd, sessionPath, ...rest } = options;
		const env = new NodeExecutionEnv({ cwd });
		const session = await openOrCreateSession(env, sessionPath, cwd);
		return new AgentHarness<TSkill, TPromptTemplate, TTool>({ env, session, ...rest });
	}

	private constructor(options: AgentHarnessInit<TSkill, TPromptTemplate, TTool>) {
		this.env = options.env;
		this.session = options.session;
		this.sessionWriter = new SessionWriter(this.session);
		this.systemPrompt = options.systemPrompt;
		this.models = options.models;
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.resources = options.resources ?? {};
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) {
			this.tools.set(tool.name, tool);
		}

		this.activeToolNames = options.activeToolNames
			? [...options.activeToolNames]
			: (options.tools ?? []).map((tool) => tool.name);
		this.validateToolNames(this.activeToolNames);
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
		this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0)
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
	}

	private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}

	private buildTurnStateFromConfig(): Promise<TurnState<TSkill, TPromptTemplate, TTool>> {
		return buildTurnState({
			session: this.session,
			env: this.env,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools: this.tools,
			activeToolNames: this.activeToolNames,
			resources: this.getResources(),
			streamOptions: this.streamOptions,
			systemPrompt: this.systemPrompt,
		});
	}

	private async emitQueueUpdate(): Promise<void> {
		const snap = this.queues.snapshot();
		await this.events.emit({
			type: "queue_update",
			steer: snap.steer,
			followUp: snap.followUp,
			nextTurn: snap.nextTurn,
		});
	}

	private async executeTurn(
		turnState: TurnState<TSkill, TPromptTemplate, TTool>,
		text: string,
		options?: { images?: ImageContent[] },
	): Promise<AssistantMessage> {
		let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
		const queued = await this.queues.takeNextTurn(() => this.emitQueueUpdate());
		if (queued.length > 0) {
			messages = [...queued, messages[0]!];
		}
		const beforeResult = await this.events.emitHook({
			type: "before_agent_start",
			prompt: text,
			images: options?.images,
			systemPrompt: turnState.systemPrompt,
			resources: turnState.resources,
		});
		if (beforeResult?.messages) messages = [...messages, ...beforeResult.messages];

		const abortController = new AbortController();
		this.runAbortController = abortController;
		const runner = new TurnRunner<TSkill, TPromptTemplate, TTool>({
			session: this.session,
			models: this.models,
			events: this.events,
			queues: this.queues,
			sessionWriter: this.sessionWriter,
			signal: abortController.signal,
			steeringMode: this.steeringQueueMode,
			followUpMode: this.followUpQueueMode,
			turnState,
			refreshTurnState: () => this.buildTurnStateFromConfig(),
			emitQueueUpdate: () => this.emitQueueUpdate(),
			markIdle: () => {
				this.phase = "idle";
			},
		});
		try {
			const newMessages = await runner.run(messages, buildContext(turnState, beforeResult?.systemPrompt));
			for (let i = newMessages.length - 1; i >= 0; i--) {
				const message = newMessages[i]!;
				if (message.role === "assistant") {
					return message;
				}
			}
			throw new AgentHarnessError("invalid_state", "AgentHarness prompt completed without an assistant message");
		} finally {
			try {
				await this.sessionWriter.flush();
			} finally {
				this.runAbortController = undefined;
			}
		}
	}

	private startRunPromise(): () => void {
		let finish = () => {};
		this.runPromise = new Promise<void>((resolve) => {
			finish = resolve;
		});
		return () => {
			this.runPromise = undefined;
			finish();
		};
	}

	/**
	 * Single external entry point for user input. Routes by phase: when idle it
	 * starts a new turn and resolves with the assistant message; when a turn is
	 * in flight it steers the running turn and resolves with `void`.
	 *
	 * Internal `followUp`/`nextTurn` routing is intentionally not exposed yet.
	 */
	async send(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage | void> {
		if (this.phase === "idle") {
			return this.prompt(text, options);
		}
		return this.steer(text, options);
	}

	private async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.buildTurnStateFromConfig();
			return await this.executeTurn(turnState, text, options);
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	private async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.buildTurnStateFromConfig();
			const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
			if (!skill) throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
			return await this.executeTurn(turnState, formatSkillInvocation(skill, additionalInstructions));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	private async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
		if (this.phase !== "idle") throw new AgentHarnessError("busy", "AgentHarness is busy");
		this.phase = "turn";
		const finishRunPromise = this.startRunPromise();
		try {
			const turnState = await this.buildTurnStateFromConfig();
			const template = (turnState.resources.promptTemplates ?? []).find((candidate) => candidate.name === name);
			if (!template) throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
			return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
		} catch (error) {
			this.phase = "idle";
			throw normalizeHarnessError(error, "unknown");
		} finally {
			finishRunPromise();
		}
	}

	private async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
		this.queues.enqueueSteer(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	private async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		if (this.phase === "idle") throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
		this.queues.enqueueFollowUp(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	private async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
		this.queues.enqueueNextTurn(createUserMessage(text, options?.images));
		await this.emitQueueUpdate();
	}

	getModel(): Model<any> {
		return this.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		try {
			const previousModel = this.model;
			this.model = model;
			await this.events.emit({ type: "model_update", model, previousModel, source: "set" });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		try {
			const previousLevel = this.thinkingLevel;
			this.thinkingLevel = level;
			await this.events.emit({ type: "thinking_level_update", level, previousLevel });
		} catch (error) {
			throw normalizeHarnessError(error, "session");
		}
	}

	private getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	async abort(): Promise<AbortResult> {
		const { clearedSteer, clearedFollowUp } = this.queues.clearForAbort();
		this.runAbortController?.abort();
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.waitForIdle();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.events.emit({ type: "abort", clearedSteer, clearedFollowUp });
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	private async waitForIdle(): Promise<void> {
		await this.runPromise;
	}

	// TODO(api-audit): `subscribe`/`on` are kept public for now, but the plan is
	// to make them private. External consumers must not attach hooks that mutate
	// internal flow; when a caller needs data out, expose a purpose-built,
	// narrow read-only interface on AgentHarness instead of the full event bus.
	subscribe(
		listener: (event: AgentNotificationEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.events.subscribe(listener);
	}

	// TODO(api-audit): planned to become private (see note on `subscribe`).
	on<TType extends keyof AgentHookEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHookEvent, { type: TType }>,
		) => Promise<AgentHookEventResultMap[TType]> | AgentHookEventResultMap[TType],
	): () => void {
		return this.events.on(type, handler);
	}
}
