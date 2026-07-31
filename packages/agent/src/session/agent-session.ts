import { cleanupSessionResources, type Model, type UserMessage } from "@loopiq/ai";
import type { ExecutionEnv } from "../base/env.ts";
import type { AgentMessage } from "../base/messages.ts";
import type { ModelReference, SessionConfiguration, ThinkingLevel } from "../base/options.ts";
import type { AgentTool } from "../base/resource.ts";
import { AgentRuntimeError, normalizeRuntimeError, toError } from "../base/types.ts";
import type { AgentEngine } from "../engine/agent-engine.ts";
import type { AgentUserInput } from "../engine/agent-run.ts";
import { type AgentRunController, createAgentRunController } from "../engine/agent-run-control.ts";
import type { AgentRunOutcome } from "../engine/agent-run-outcome.ts";
import type { AgentRunPort } from "../engine/agent-run-port.ts";
import { createUserMessage } from "../engine/message-factory.ts";
import type { TurnState } from "../engine/turn-state.ts";
import { createDefaultTools } from "../tools/index.ts";
import type { AgentEventEnvelope, AgentEventListener, RunSettledEvent } from "./event-envelope.ts";
import type {
	AbortResult,
	RunHandle,
	RunResult,
	SessionSnapshot,
	SessionState,
	SteerOptions,
} from "./session-contracts.ts";
import { SteeringQueue } from "./steering-queue.ts";
import type { JsonlSessionStore } from "./storage/jsonl-session-store.ts";
import { uuidv7 } from "./uuid.ts";

type AgentSessionLoadOptions = {
	env: ExecutionEnv;
	store: JsonlSessionStore;
	engine: AgentEngine;
	defaults: { model: ModelReference; thinkingLevel: ThinkingLevel };
	newSession?: { model?: ModelReference; thinkingLevel?: ThinkingLevel };
};

type CurrentRun = {
	handle: RunHandle;
	control: AgentRunController;
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolver) => {
		resolve = resolver;
	});
	return { promise, resolve };
}

/** One loaded Session runtime: context, configuration, tools, steering, notifications, and Run lifecycle. */
export class AgentSession {
	readonly id: string;
	private state: SessionState = "idle";
	private currentRun?: CurrentRun;
	private readonly store: JsonlSessionStore;
	private readonly env: ExecutionEnv;
	private readonly engine: AgentEngine;
	private readonly steering = new SteeringQueue();
	private readonly listeners = new Set<AgentEventListener>();
	private readonly runtimeId = uuidv7();
	private sequence = 0;
	private readonly tools: AgentTool[];
	private messages: AgentMessage[];
	private model: Model<any>;
	private thinkingLevel: ThinkingLevel;
	private pendingConfig?: SessionConfiguration;

	private constructor(
		options: AgentSessionLoadOptions,
		model: Model<any>,
		thinkingLevel: ThinkingLevel,
		tools: AgentTool[],
		messages: AgentMessage[],
	) {
		this.id = options.store.metadata.id;
		this.store = options.store;
		this.env = options.env;
		this.engine = options.engine;
		this.messages = messages;
		this.model = model;
		this.thinkingLevel = thinkingLevel;
		this.tools = tools;
	}

	static async load(options: AgentSessionLoadOptions): Promise<AgentSession> {
		const restored = options.store.restore();
		const persisted = options.newSession ? undefined : restored.configuration;
		const tools = createDefaultTools(options.env);
		const modelReference = options.newSession?.model ?? persisted?.model ?? options.defaults.model;
		const model = options.engine.resolveModel(modelReference);
		const config: SessionConfiguration = persisted ?? {
			model: { providerId: model.provider, modelId: model.id },
			thinkingLevel: options.newSession?.thinkingLevel ?? options.defaults.thinkingLevel,
		};
		const session = new AgentSession(options, model, config.thinkingLevel, tools, restored.messages);
		if (!persisted) await options.store.appendConfiguration(config);
		return session;
	}

	getSnapshot(): SessionSnapshot {
		return {
			id: this.id,
			workspaceDir: this.store.metadata.workspaceDir,
			state: this.state,
			currentRunId: this.currentRun?.handle.runId,
			model: { providerId: this.model.provider, modelId: this.model.id },
			thinkingLevel: this.thinkingLevel,
		};
	}

	startRun(input: AgentUserInput): RunHandle {
		if (!input.text.trim()) throw new AgentRuntimeError("invalid_argument", "Run input text must not be empty");
		if (this.state !== "idle") throw new AgentRuntimeError("busy", "AgentSession is busy");

		const runId = uuidv7();
		const control = createAgentRunController();
		const result = deferred<RunResult>();
		const handle = { sessionId: this.id, runId, result: result.promise };
		this.state = "running";
		this.currentRun = { handle, control };

		void this.executeReservedRun(runId, input, control).then(result.resolve, (error) =>
			result.resolve(this.toUnexpectedFailure(runId, error)),
		);
		return handle;
	}

	async steer(runId: string, input: AgentUserInput, options?: SteerOptions): Promise<void> {
		const current = this.requireCurrentRun(runId, "steer");
		this.steering.enqueue(this.createUserInputMessage(input));
		await this.emitSteeringQueueUpdate();
		if (options?.interruptCurrentInference) current.control.interruptInference("steer");
	}

	async abort(runId: string): Promise<AbortResult> {
		const current = this.requireCurrentRun(runId, "abort");
		const clearedSteering = this.steering.clear();
		current.control.abortRun();
		const errors: Error[] = [];
		try {
			await this.emitSteeringQueueUpdate();
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
			throw normalizeRuntimeError(cause, "unknown");
		}
		return { clearedSteering };
	}

	subscribe(listener: AgentEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async updateConfiguration(update: { model?: Model<any>; thinkingLevel?: ThinkingLevel }): Promise<void> {
		const model = update.model ?? this.model;
		const thinkingLevel = update.thinkingLevel ?? this.thinkingLevel;
		const modelChanged = model.provider !== this.model.provider || model.id !== this.model.id;
		const thinkingLevelChanged = thinkingLevel !== this.thinkingLevel;
		if (!modelChanged && !thinkingLevelChanged) return;

		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		await this.persistConfig({ model, thinkingLevel });
		this.model = model;
		this.thinkingLevel = thinkingLevel;

		const runId = this.currentRun?.handle.runId;
		if (modelChanged) await this.dispatchEnvelope({ type: "model_update", model, previousModel }, runId);
		if (thinkingLevelChanged) {
			await this.dispatchEnvelope(
				{ type: "thinking_level_update", level: thinkingLevel, previousLevel: previousThinkingLevel },
				runId,
			);
		}
	}

	async close(): Promise<void> {
		if (this.state === "closed") return;
		if (this.state !== "idle") throw new AgentRuntimeError("busy", "Cannot close a busy AgentSession");
		this.state = "closing";
		const errors: Error[] = [];
		try {
			await this.flushPendingSessionState();
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			cleanupSessionResources(this.id);
		} catch (error) {
			errors.push(toError(error));
		}
		try {
			await this.env.cleanup();
		} catch (error) {
			errors.push(toError(error));
		}
		this.listeners.clear();
		this.state = "closed";
		if (errors.length > 0) {
			const cause = errors.length === 1 ? errors[0]! : new AggregateError(errors, "AgentSession close failed");
			throw normalizeRuntimeError(cause, "session");
		}
	}

	private async executeReservedRun(
		runId: string,
		input: AgentUserInput,
		control: AgentRunController,
	): Promise<RunResult> {
		let outcome: AgentRunOutcome;
		try {
			const initialMessages = this.messages.slice();
			const initialSnapshot = this.createTurnSnapshot();
			outcome = await this.engine.run(
				{ sessionId: this.id, ...input, initialMessages, initialSnapshot, control },
				this.createRunPort(runId),
			);
		} catch (error) {
			outcome = { status: "failed", messages: [], error: toError(error) };
		}

		this.assertCurrentRun(runId);
		this.state = "settling";
		let result = this.toRunResult(runId, outcome);
		try {
			await this.flushPendingSessionState();
		} catch (error) {
			result = { ...result, status: "failed", error: toError(error) };
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

	private createRunPort(runId: string): AgentRunPort {
		return {
			drainSteering: async () => {
				this.assertCurrentRun(runId);
				return this.steering.drainOne(() => this.emitSteeringQueueUpdate());
			},
			commitMessage: async (message) => {
				this.assertCurrentRun(runId);
				await this.store.appendMessage(message);
				this.messages.push(message);
			},
			flushPendingSessionState: () => this.flushPendingSessionState(),
			createTurnSnapshot: () => {
				this.assertCurrentRun(runId);
				return this.createTurnSnapshot();
			},
			emit: async (event) => {
				this.assertCurrentRun(runId);
				await this.dispatchEnvelope(event, runId);
			},
		};
	}

	private createTurnSnapshot(): TurnState {
		return this.engine.createTurnSnapshot({
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools: this.tools,
		});
	}

	private createUserInputMessage(input: AgentUserInput): UserMessage {
		return createUserMessage(input.text, input.images);
	}

	private requireCurrentRun(runId: string, operation: string): CurrentRun {
		this.assertCurrentRun(runId);
		if (this.state !== "running") {
			throw new AgentRuntimeError("invalid_state", `Cannot ${operation} while AgentRun is ${this.state}`);
		}
		return this.currentRun!;
	}

	private assertCurrentRun(runId: string): void {
		if (this.currentRun?.handle.runId !== runId) {
			throw new AgentRuntimeError("invalid_state", "Stale or mismatched AgentRun identity");
		}
	}

	private async emitSteeringQueueUpdate(): Promise<void> {
		await this.dispatchEnvelope(
			{ type: "steering_queue_update", messages: this.steering.snapshot() },
			this.currentRun?.handle.runId,
		);
	}

	private async dispatchEnvelope(event: AgentEventEnvelope["event"], runId?: string): Promise<void> {
		const envelope: AgentEventEnvelope = {
			sessionId: this.id,
			runtimeId: this.runtimeId,
			runId,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			event,
		};
		for (const listener of this.listeners) await listener(envelope);
	}

	private toRunResult(runId: string, outcome: AgentRunOutcome): RunResult {
		return {
			sessionId: this.id,
			runId,
			status: outcome.status,
			messages: outcome.messages,
			finalMessage: outcome.finalMessage,
			error: outcome.status === "failed" ? outcome.error : undefined,
		};
	}

	private toUnexpectedFailure(runId: string, error: unknown): RunResult {
		this.currentRun?.control.dispose();
		this.currentRun = undefined;
		this.state = "idle";
		return { sessionId: this.id, runId, status: "failed", messages: [], error: toError(error) };
	}

	private errorCode(error: Error): string {
		return "code" in error && typeof error.code === "string" ? error.code : "unknown";
	}

	private async persistConfig(values: { model: Model<any>; thinkingLevel: ThinkingLevel }): Promise<void> {
		const config: SessionConfiguration = {
			model: { providerId: values.model.provider, modelId: values.model.id },
			thinkingLevel: values.thinkingLevel,
		};
		if (this.state === "idle") {
			await this.store.appendConfiguration(config);
			return;
		}
		this.pendingConfig = config;
	}

	private async flushPendingSessionState(): Promise<boolean> {
		let flushed = false;
		while (this.pendingConfig) {
			const config = this.pendingConfig;
			await this.store.appendConfiguration(config);
			flushed = true;
			if (this.pendingConfig === config) this.pendingConfig = undefined;
		}
		return flushed;
	}
}
