import type { AssistantMessage, Model } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentHookEvent, AgentHookEventResultMap, AgentNotificationEvent } from "../base/events.ts";
import type { AgentHarnessOptions, AgentHarnessStreamOptions, QueueMode, ThinkingLevel } from "../base/options.ts";
import type { AgentHarnessResources, AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import type { AbortResult } from "../base/session-types.ts";
import { AgentHarnessError, normalizeHarnessError, toError } from "../base/types.ts";
import { AgentEventBus } from "../core/event-bus.ts";
import { createUserMessage } from "../core/message-factory.ts";
import { cloneStreamOptions } from "../core/stream-options.ts";
import { buildTurnState, type TurnState } from "../core/turn-state.ts";
import type { AgentEngine } from "../engine/agent-engine.ts";
import type { AgentUserInput } from "../engine/agent-run.ts";
import { type AgentRunController, createAgentRunController } from "../engine/agent-run-control.ts";
import type { AgentRunOutcome } from "../engine/agent-run-outcome.ts";
import type { AgentRunPort } from "../engine/agent-run-port.ts";
import { MessageQueues } from "../queue/message-queues.ts";
import type { Session } from "../session/session.ts";
import { SessionWriter } from "../session/session-writer.ts";
import { uuidv7 } from "../session/uuid.ts";
import type { AgentEventEnvelope, AgentEventListener, RunSettledEvent } from "./event-envelope.ts";
import type { ModelReference, PersistedSessionConfigV1 } from "./persisted-session-config.ts";

export type AgentSessionState = "idle" | "running" | "settling" | "closing" | "closed";

export interface AgentRunResult {
	sessionId: string;
	runId: string;
	status: "completed" | "aborted" | "failed";
	messages: import("../base/messages.ts").AgentMessage[];
	finalMessage?: AssistantMessage;
	error?: Error;
}

export interface AgentRunHandle {
	sessionId: string;
	runId: string;
	result: Promise<AgentRunResult>;
}

export interface AgentSteerOptions {
	interruptCurrentInference?: boolean;
}

export interface AgentSessionSnapshot {
	id: string;
	state: AgentSessionState;
	currentRunId?: string;
	model: ModelReference;
	thinkingLevel: ThinkingLevel;
}

export interface AgentSessionOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> extends Omit<AgentHarnessOptions<TSkill, TPromptTemplate, TTool>, "cwd" | "sessionPath" | "models"> {
	env: ExecutionEnv;
	session: Session;
	engine: AgentEngine;
	persistConfig?: (config: PersistedSessionConfigV1, writer: SessionWriter) => Promise<void>;
	onClose?: () => Promise<void>;
}

interface CurrentRun {
	handle: AgentRunHandle;
	control: AgentRunController;
	abortResult?: AbortResult;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

function findDuplicateNames(names: string[]): string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) duplicates.add(name);
		seen.add(name);
	}
	return [...duplicates];
}

export class AgentSession<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	readonly id: string;
	private state: AgentSessionState = "idle";
	private currentRun?: CurrentRun;
	private readonly sessionWriter: SessionWriter;
	private readonly queues = new MessageQueues();
	private readonly events = new AgentEventBus<TSkill, TPromptTemplate>();
	private readonly listeners = new Set<AgentEventListener>();
	private readonly runtimeId = uuidv7();
	private sequence = 0;
	private readonly tools = new Map<string, TTool>();
	private readonly resources: AgentHarnessResources<TSkill, TPromptTemplate>;
	private readonly streamOptions: AgentHarnessStreamOptions;
	private readonly systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private activeToolNames: string[];
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private readonly options: AgentSessionOptions<TSkill, TPromptTemplate, TTool>;

	private constructor(options: AgentSessionOptions<TSkill, TPromptTemplate, TTool>, id: string) {
		this.options = options;
		this.id = id;
		this.sessionWriter = new SessionWriter(options.session);
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.resources = options.resources ?? {};
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.systemPrompt = options.systemPrompt;
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.validateUniqueNames(
			(options.tools ?? []).map((tool) => tool.name),
			"Duplicate tool name(s)",
		);
		for (const tool of options.tools ?? []) this.tools.set(tool.name, tool);
		this.activeToolNames = options.activeToolNames ? [...options.activeToolNames] : [...this.tools.keys()];
		this.validateToolNames(this.activeToolNames);
		this.events.subscribe((event, signal) => this.dispatchEnvelope(event, this.currentRun?.handle.runId, signal));
	}

	static async create<
		TSkill extends Skill = Skill,
		TPromptTemplate extends PromptTemplate = PromptTemplate,
		TTool extends AgentTool = AgentTool,
	>(
		options: AgentSessionOptions<TSkill, TPromptTemplate, TTool>,
	): Promise<AgentSession<TSkill, TPromptTemplate, TTool>> {
		const metadata = await options.session.getMetadata();
		return new AgentSession(options, metadata.id);
	}

	getSnapshot(): AgentSessionSnapshot {
		return {
			id: this.id,
			state: this.state,
			currentRunId: this.currentRun?.handle.runId,
			model: { providerId: this.model.provider, modelId: this.model.id },
			thinkingLevel: this.thinkingLevel,
		};
	}

	startRun(input: AgentUserInput): AgentRunHandle {
		if (!input.text.trim()) throw new AgentHarnessError("invalid_argument", "Run input text must not be empty");
		if (this.state !== "idle") throw new AgentHarnessError("busy", "AgentSession is busy");

		const runId = uuidv7();
		const control = createAgentRunController();
		const result = deferred<AgentRunResult>();
		const handle = { sessionId: this.id, runId, result: result.promise };
		this.state = "running";
		this.currentRun = { handle, control };

		void this.executeReservedRun(runId, input, control).then(result.resolve, (error) =>
			result.resolve(this.toUnexpectedFailure(runId, error)),
		);
		return handle;
	}

	async steer(runId: string, input: AgentUserInput, options?: AgentSteerOptions): Promise<void> {
		const current = this.requireCurrentRun(runId, "steer");
		this.queues.enqueueSteer(this.createUserInputMessage(input));
		await this.emitQueueUpdate();
		if (options?.interruptCurrentInference) current.control.interruptInference("steer");
	}

	async abort(runId: string): Promise<AbortResult> {
		const current = this.requireCurrentRun(runId, "abort");
		const { clearedSteer, clearedFollowUp } = this.queues.clearForAbort();
		current.abortResult = { clearedSteer, clearedFollowUp };
		current.control.abortRun();
		const errors: Error[] = [];
		try {
			await this.emitQueueUpdate();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await current.handle.result;
		} catch (error) {
			errors.push(toError(error));
		}
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "Abort completed with errors");
			throw normalizeHarnessError(cause, "hook");
		}
		return { clearedSteer, clearedFollowUp };
	}

	async abortCurrent(): Promise<AbortResult> {
		const runId = this.currentRun?.handle.runId;
		if (runId) return this.abort(runId);
		const { clearedSteer, clearedFollowUp } = this.queues.clearForAbort();
		await this.emitQueueUpdate();
		await this.events.emit({ type: "abort", clearedSteer, clearedFollowUp });
		return { clearedSteer, clearedFollowUp };
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	subscribeLegacy(
		listener: (event: AgentNotificationEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		return this.events.subscribe(listener);
	}

	on<TType extends keyof AgentHookEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHookEvent, { type: TType }>,
		) => Promise<AgentHookEventResultMap[TType]> | AgentHookEventResultMap[TType],
	): () => void {
		return this.events.on(type, handler);
	}

	getModel(): Model<any> {
		return this.model;
	}

	async setModel(model: Model<any>): Promise<void> {
		const previousModel = this.model;
		await this.persistConfig({ model, thinkingLevel: this.thinkingLevel });
		this.model = model;
		await this.events.emit({ type: "model_update", model, previousModel, source: "set" });
	}

	getThinkingLevel(): ThinkingLevel {
		return this.thinkingLevel;
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const previousLevel = this.thinkingLevel;
		await this.persistConfig({ model: this.model, thinkingLevel: level });
		this.thinkingLevel = level;
		await this.events.emit({ type: "thinking_level_update", level, previousLevel });
	}

	getRuntimeConfig(): PersistedSessionConfigV1 {
		return {
			providerId: this.model.provider,
			modelId: this.model.id,
			thinkingLevel: this.thinkingLevel,
			activeToolNames: [...this.activeToolNames],
		};
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		if (this.state !== "idle") throw new AgentHarnessError("busy", "Cannot close a busy AgentSession");
		this.state = "closing";
		const errors: Error[] = [];
		try {
			await this.sessionWriter.flush();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.options.onClose?.();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.options.env.cleanup();
		} catch (error) {
			errors.push(toError(error));
		}
		this.listeners.clear();
		this.state = "closed";
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "AgentSession close failed");
			throw normalizeHarnessError(cause, "session");
		}
	}

	private async executeReservedRun(
		runId: string,
		input: AgentUserInput,
		control: AgentRunController,
	): Promise<AgentRunResult> {
		let outcome: AgentRunOutcome;
		try {
			const initialSnapshot = await this.createTurnSnapshot(control.runSignal);
			outcome = await this.options.engine.run(
				{ sessionId: this.id, runId, input, initialSnapshot, control },
				this.createRunPort(runId),
			);
		} catch (error) {
			outcome = { status: "failed", messages: [], error: toError(error) };
		}

		this.assertCurrentRun(runId);
		this.state = "settling";
		let result = this.toRunResult(runId, outcome);
		try {
			await this.sessionWriter.flush();
			await this.events.emit(
				{ type: "settled", nextTurnCount: this.queues.snapshot().nextTurn.length },
				control.runSignal,
			);
			const abortResult = this.currentRun?.abortResult;
			if (abortResult) await this.events.emit({ type: "abort", ...abortResult }, control.runSignal);
		} catch (error) {
			result = {
				...result,
				status: "failed",
				error: toError(error),
			};
		}

		const terminal: RunSettledEvent = {
			type: "run_settled",
			status: result.status,
			error: result.error ? { code: this.errorCode(result.error), message: result.error.message } : undefined,
		};
		try {
			await this.dispatchEnvelope(terminal, runId);
		} catch {
			// A terminal observer cannot rewrite an already-final run result.
		}
		this.assertCurrentRun(runId);
		control.dispose();
		this.currentRun = undefined;
		this.state = "idle";
		return result;
	}

	private createRunPort(runId: string): AgentRunPort<TSkill, TPromptTemplate, TTool> {
		return {
			takeNextTurn: async () => {
				this.assertCurrentRun(runId);
				return this.queues.takeNextTurn(() => this.emitQueueUpdate());
			},
			drainSteering: async () => {
				this.assertCurrentRun(runId);
				return this.queues.drainSteer(this.steeringMode, () => this.emitQueueUpdate());
			},
			drainFollowUp: async () => {
				this.assertCurrentRun(runId);
				return this.queues.drainFollowUp(this.followUpMode, () => this.emitQueueUpdate());
			},
			commitMessage: async (message) => {
				this.assertCurrentRun(runId);
				await this.options.session.appendMessage(message);
			},
			hasPendingWrites: () => this.sessionWriter.hasPending(),
			flushPendingWrites: () => this.sessionWriter.flush(),
			createTurnSnapshot: (signal) => {
				this.assertCurrentRun(runId);
				return this.createTurnSnapshot(signal);
			},
			emit: async (event, signal) => {
				this.assertCurrentRun(runId);
				await this.events.emit(event, signal);
			},
			emitHook: async (event) => {
				this.assertCurrentRun(runId);
				return this.events.emitHook(event);
			},
		};
	}

	private async createTurnSnapshot(signal: AbortSignal): Promise<TurnState<TSkill, TPromptTemplate, TTool>> {
		const snapshot = await buildTurnState({
			session: this.options.session,
			env: this.options.env,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools: this.tools,
			activeToolNames: this.activeToolNames,
			resources: this.getResources(),
			streamOptions: this.streamOptions,
			systemPrompt: this.systemPrompt,
		});
		// Snapshot providers do not accept AbortSignal yet. Preserve a complete
		// snapshot so the engine can emit the normal aborted assistant artifact.
		void signal;
		return snapshot;
	}

	private getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
		return {
			skills: this.resources.skills?.slice(),
			promptTemplates: this.resources.promptTemplates?.slice(),
		};
	}

	private createUserInputMessage(input: AgentUserInput) {
		return createUserMessage(input.text, input.images);
	}

	private requireCurrentRun(runId: string, operation: string): CurrentRun {
		this.assertCurrentRun(runId);
		if (this.state !== "running") {
			throw new AgentHarnessError("invalid_state", `Cannot ${operation} while AgentRun is ${this.state}`);
		}
		return this.currentRun!;
	}

	private assertCurrentRun(runId: string): void {
		if (this.currentRun?.handle.runId !== runId) {
			throw new AgentHarnessError("invalid_state", "Stale or mismatched AgentRun identity");
		}
	}

	private async emitQueueUpdate(): Promise<void> {
		const snapshot = this.queues.snapshot();
		await this.events.emit({
			type: "queue_update",
			steer: snapshot.steer,
			followUp: snapshot.followUp,
			nextTurn: snapshot.nextTurn,
		});
	}

	private async dispatchEnvelope(
		event: AgentEventEnvelope["event"],
		runId?: string,
		_signal?: AbortSignal,
	): Promise<void> {
		const envelope: AgentEventEnvelope = {
			schemaVersion: 1,
			sessionId: this.id,
			runtimeId: this.runtimeId,
			runId,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			event,
		};
		for (const listener of this.listeners) await listener(envelope);
	}

	private toRunResult(runId: string, outcome: AgentRunOutcome): AgentRunResult {
		return {
			sessionId: this.id,
			runId,
			status: outcome.status,
			messages: outcome.messages,
			finalMessage: outcome.finalMessage,
			error: outcome.status === "failed" ? outcome.error : undefined,
		};
	}

	private toUnexpectedFailure(runId: string, error: unknown): AgentRunResult {
		this.currentRun?.control.dispose();
		this.currentRun = undefined;
		this.state = "idle";
		return { sessionId: this.id, runId, status: "failed", messages: [], error: toError(error) };
	}

	private errorCode(error: Error): string {
		return "code" in error && typeof error.code === "string" ? error.code : "unknown";
	}

	private async persistConfig(values: { model: Model<any>; thinkingLevel: ThinkingLevel }): Promise<void> {
		await this.options.persistConfig?.(
			{
				providerId: values.model.provider,
				modelId: values.model.id,
				thinkingLevel: values.thinkingLevel,
				activeToolNames: [...this.activeToolNames],
			},
			this.sessionWriter,
		);
		if (this.state === "idle") await this.sessionWriter.flush();
	}

	private validateUniqueNames(names: string[], message: string): void {
		const duplicates = findDuplicateNames(names);
		if (duplicates.length > 0) {
			throw new AgentHarnessError("invalid_argument", `${message}: ${duplicates.join(", ")}`);
		}
	}

	private validateToolNames(toolNames: string[]): void {
		this.validateUniqueNames(toolNames, "Duplicate active tool name(s)");
		const missing = toolNames.filter((name) => !this.tools.has(name));
		if (missing.length > 0) throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
	}
}
