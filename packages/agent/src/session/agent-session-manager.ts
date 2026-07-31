import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Model } from "@loopiq/ai";
import type { ModelReference, ThinkingLevel } from "../base/options.ts";
import { AgentRuntimeError, normalizeRuntimeError, toError } from "../base/types.ts";
import type { AgentEngine } from "../engine/agent-engine.ts";
import type { AgentUserInput } from "../engine/agent-run.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { AgentSession } from "./agent-session.ts";
import type { AgentEventListener } from "./event-envelope.ts";
import type {
	AbortResult,
	CreateSessionOptions,
	RunHandle,
	SessionSnapshot,
	SessionSummary,
	SteerOptions,
	UpdateSessionOptions,
} from "./session-contracts.ts";
import { JsonlSessionStore } from "./storage/jsonl-session-store.ts";
import { acquireSessionStoreLease, type SessionStoreLease } from "./storage/session-store-lease.ts";

/** Manages loaded AgentSession instances and their Node-specific durable resources. */
export class AgentSessionManager {
	private readonly engine: AgentEngine;
	private readonly getSessionDefaults: () => { model: ModelReference; thinkingLevel: ThinkingLevel };
	private readonly resolveSwitchableModel: (reference: ModelReference) => Promise<Model<any>>;
	private readonly loaded = new Map<string, { session: AgentSession; lease: SessionStoreLease }>();
	private readonly opening = new Map<string, Promise<AgentSession>>();
	private readonly sessionsDir: string;
	private readonly storeFileSystem: NodeExecutionEnv;

	constructor(
		agentHome: string,
		engine: AgentEngine,
		getSessionDefaults: () => { model: ModelReference; thinkingLevel: ThinkingLevel },
		resolveSwitchableModel: (reference: ModelReference) => Promise<Model<any>>,
	) {
		this.engine = engine;
		this.getSessionDefaults = getSessionDefaults;
		this.resolveSwitchableModel = resolveSwitchableModel;
		this.sessionsDir = join(agentHome, "sessions");
		this.storeFileSystem = new NodeExecutionEnv({ cwd: this.sessionsDir });
	}

	async createSession(options: CreateSessionOptions): Promise<SessionSnapshot> {
		return (await this.create(options)).getSnapshot();
	}

	async getSession(sessionId: string): Promise<SessionSnapshot> {
		return (await this.open(sessionId)).getSnapshot();
	}

	listSessions(): Promise<SessionSummary[]> {
		return this.list();
	}

	async updateSession(sessionId: string, options: UpdateSessionOptions): Promise<SessionSnapshot> {
		const session = await this.open(sessionId);
		const model = options.model ? await this.resolveSwitchableModel(options.model) : undefined;
		await session.updateConfiguration({ model, thinkingLevel: options.thinkingLevel });
		return session.getSnapshot();
	}

	async run(sessionId: string, input: AgentUserInput): Promise<RunHandle> {
		return (await this.open(sessionId)).startRun(input);
	}

	async steer(sessionId: string, runId: string, input: AgentUserInput, options?: SteerOptions): Promise<void> {
		await (await this.open(sessionId)).steer(runId, input, options);
	}

	abort(sessionId: string, runId: string): Promise<AbortResult> {
		return this.open(sessionId).then((session) => session.abort(runId));
	}

	async subscribe(sessionId: string, listener: AgentEventListener): Promise<() => void> {
		return (await this.open(sessionId)).subscribe(listener);
	}

	async create(options: CreateSessionOptions): Promise<AgentSession> {
		const workspaceDir = await this.resolveWorkspaceDir(options.workspaceDir);
		await mkdir(this.sessionsDir, { recursive: true });
		const sessionId = randomUUID();
		const sessionDir = this.sessionDir(sessionId);
		await mkdir(sessionDir, { recursive: false });
		const lease = await acquireSessionStoreLease(join(sessionDir, "runtime.lock"));
		const env = new NodeExecutionEnv({ cwd: workspaceDir });
		try {
			const store = await JsonlSessionStore.create(this.storeFileSystem, join(sessionDir, "session.jsonl"), {
				workspaceDir,
				sessionId,
			});
			return await this.loadSession(env, store, lease, {
				model: options.model,
				thinkingLevel: options.thinkingLevel,
			});
		} catch (error) {
			await env.cleanup().catch(() => undefined);
			await lease.release();
			await rm(sessionDir, { recursive: true, force: true });
			throw normalizeRuntimeError(error, "session");
		}
	}

	async open(sessionId: string): Promise<AgentSession> {
		const loaded = this.loaded.get(sessionId);
		if (loaded) return loaded.session;
		const inFlight = this.opening.get(sessionId);
		if (inFlight) return inFlight;
		const opening = this.openUnloaded(sessionId);
		this.opening.set(sessionId, opening);
		try {
			return await opening;
		} finally {
			this.opening.delete(sessionId);
		}
	}

	async list(): Promise<SessionSummary[]> {
		await mkdir(this.sessionsDir, { recursive: true });
		const entries = await readdir(this.sessionsDir, { withFileTypes: true });
		const summaries: SessionSummary[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				const sessionPath = join(this.sessionsDir, entry.name, "session.jsonl");
				const metadata = await JsonlSessionStore.readMetadata(this.storeFileSystem, sessionPath);
				const fileStat = await stat(sessionPath);
				const snapshot = this.loaded.get(metadata.id)?.session.getSnapshot();
				summaries.push({
					id: metadata.id,
					workspaceDir: metadata.workspaceDir,
					createdAt: metadata.createdAt,
					updatedAt: fileStat.mtime.toISOString(),
					loadedState: snapshot?.state ?? "unloaded",
					model: snapshot?.model,
					thinkingLevel: snapshot?.thinkingLevel,
				});
			} catch {
				// Invalid Session directories are ignored by discovery and fail on explicit open.
			}
		}
		return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async close(sessionId: string): Promise<void> {
		const loaded = this.loaded.get(sessionId);
		if (!loaded) return;
		let closeError: unknown;
		try {
			await loaded.session.close();
		} catch (error) {
			if (loaded.session.getSnapshot().state !== "closed") throw error;
			closeError = error;
		}
		this.loaded.delete(sessionId);
		try {
			await loaded.lease.release();
		} catch (releaseError) {
			if (closeError) {
				throw new AggregateError([toError(closeError), toError(releaseError)], "Failed to close AgentSession");
			}
			throw releaseError;
		}
		if (closeError) throw closeError;
	}

	async delete(sessionId: string): Promise<void> {
		await this.close(sessionId);
		const sessionDir = this.sessionDir(sessionId);
		const lease = await acquireSessionStoreLease(join(sessionDir, "runtime.lock"));
		try {
			await rm(sessionDir, { recursive: true, force: true });
		} finally {
			await lease.release().catch(() => undefined);
		}
	}

	async shutdown(options?: { abortRunning?: boolean }): Promise<void> {
		const errors: Error[] = [];
		for (const sessionId of [...this.loaded.keys()]) {
			try {
				const session = this.loaded.get(sessionId)?.session;
				const runId = session?.getSnapshot().currentRunId;
				if (runId && options?.abortRunning) await session.abort(runId);
				await this.close(sessionId);
			} catch (error) {
				errors.push(toError(error));
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "AgentSession manager shutdown completed with errors");
		}
	}

	private async openUnloaded(sessionId: string): Promise<AgentSession> {
		const sessionDir = this.sessionDir(sessionId);
		const sessionPath = join(sessionDir, "session.jsonl");
		let lease: SessionStoreLease;
		let env: NodeExecutionEnv | undefined;
		try {
			lease = await acquireSessionStoreLease(join(sessionDir, "runtime.lock"));
		} catch (error) {
			throw normalizeRuntimeError(error, error instanceof AgentRuntimeError ? error.code : "session");
		}
		try {
			const metadata = await JsonlSessionStore.readMetadata(this.storeFileSystem, sessionPath);
			if (metadata.id !== sessionId) {
				throw new AgentRuntimeError("session", `Session directory ${sessionId} contains Session ${metadata.id}`);
			}
			const workspaceDir = await this.resolveWorkspaceDir(metadata.workspaceDir);
			env = new NodeExecutionEnv({ cwd: workspaceDir });
			const store = await JsonlSessionStore.open(this.storeFileSystem, sessionPath);
			return await this.loadSession(env, store, lease);
		} catch (error) {
			await env?.cleanup().catch(() => undefined);
			await lease.release();
			throw normalizeRuntimeError(error, "session");
		}
	}

	private async loadSession(
		env: NodeExecutionEnv,
		store: JsonlSessionStore,
		lease: SessionStoreLease,
		newSession?: { model?: ModelReference; thinkingLevel?: ThinkingLevel },
	): Promise<AgentSession> {
		const session = await AgentSession.load({
			env,
			store,
			engine: this.engine,
			defaults: this.getSessionDefaults(),
			newSession,
		});
		this.loaded.set(session.id, { session, lease });
		return session;
	}

	private sessionDir(sessionId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			throw new AgentRuntimeError("invalid_argument", "Invalid Session ID");
		}
		return join(this.sessionsDir, sessionId);
	}

	private async resolveWorkspaceDir(input: string): Promise<string> {
		if (typeof input !== "string" || !input.trim()) {
			throw new AgentRuntimeError("invalid_argument", "Workspace directory must not be empty");
		}
		const workspaceDir = resolve(input);
		let workspaceStat: Awaited<ReturnType<typeof stat>>;
		try {
			workspaceStat = await stat(workspaceDir);
		} catch (error) {
			const cause = toError(error);
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				throw new AgentRuntimeError(
					"invalid_argument",
					`Workspace directory does not exist: ${workspaceDir}`,
					cause,
				);
			}
			throw new AgentRuntimeError("invalid_argument", `Cannot access Workspace directory: ${workspaceDir}`, cause);
		}
		if (!workspaceStat.isDirectory()) {
			throw new AgentRuntimeError("invalid_argument", `Workspace path is not a directory: ${workspaceDir}`);
		}
		return workspaceDir;
	}
}
