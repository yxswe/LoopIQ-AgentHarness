import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { cleanupSessionResources, type Model, type Models } from "@loopiq/ai";
import type { AgentHarnessOptions, AgentHarnessStreamOptions, QueueMode, ThinkingLevel } from "../base/options.ts";
import type { AgentHarnessResources, AgentTool, PromptTemplate, Skill } from "../base/resource.ts";
import { AgentHarnessError, normalizeHarnessError, toError } from "../base/types.ts";
import { type AgentEngine, createAgentEngine } from "../engine/agent-engine.ts";
import { NodeExecutionEnv } from "../env/nodejs.ts";
import { AgentSession } from "../runtime/agent-session.ts";
import {
	type ModelReference,
	type PersistedSessionConfigV1,
	SESSION_CONFIG_CUSTOM_TYPE,
} from "../runtime/persisted-session-config.ts";
import type { CreateSessionOptions, SessionHost, SessionSummary } from "../runtime/session-host.ts";
import { JsonlSessionStorage } from "../session/jsonl-storage.ts";
import type { SessionWriter } from "../session/session-writer.ts";
import { toSession } from "../session/storage-utils.ts";
import { acquireNodeSessionLease, type NodeSessionLease } from "./node-session-lease.ts";

export interface NodeSessionHostOptions<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> {
	dataDir: string;
	models: Models;
	engine?: AgentEngine;
	defaultModel: ModelReference;
	defaultThinkingLevel?: ThinkingLevel;
	createTools?: (env: NodeExecutionEnv) => TTool[] | Promise<TTool[]>;
	resources?: AgentHarnessResources<TSkill, TPromptTemplate>;
	systemPrompt?: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
	streamOptions?: AgentHarnessStreamOptions;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

interface LoadedSession<TSkill extends Skill, TPromptTemplate extends PromptTemplate, TTool extends AgentTool> {
	session: AgentSession<TSkill, TPromptTemplate, TTool>;
	lease: NodeSessionLease;
}

interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
}

function isPersistedConfig(value: unknown): value is PersistedSessionConfigV1 {
	if (!value || typeof value !== "object") return false;
	const config = value as Record<string, unknown>;
	const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
	return (
		typeof config.providerId === "string" &&
		typeof config.modelId === "string" &&
		typeof config.thinkingLevel === "string" &&
		thinkingLevels.has(config.thinkingLevel) &&
		Array.isArray(config.activeToolNames) &&
		config.activeToolNames.every((name) => typeof name === "string")
	);
}

export class NodeSessionHost<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
> implements SessionHost<TSkill, TPromptTemplate, TTool>
{
	private readonly options: NodeSessionHostOptions<TSkill, TPromptTemplate, TTool>;
	private readonly engine: AgentEngine;
	private readonly loaded = new Map<string, LoadedSession<TSkill, TPromptTemplate, TTool>>();
	private readonly opening = new Map<string, Promise<AgentSession<TSkill, TPromptTemplate, TTool>>>();
	private readonly sessionsDir: string;

	constructor(options: NodeSessionHostOptions<TSkill, TPromptTemplate, TTool>) {
		this.options = options;
		this.engine = options.engine ?? createAgentEngine({ models: options.models });
		this.sessionsDir = join(options.dataDir, "sessions");
	}

	async create(options: CreateSessionOptions): Promise<AgentSession<TSkill, TPromptTemplate, TTool>> {
		await mkdir(this.sessionsDir, { recursive: true });
		const sessionId = randomUUID();
		const sessionDir = this.sessionDir(sessionId);
		await mkdir(sessionDir, { recursive: false });
		const lease = await acquireNodeSessionLease(join(sessionDir, "runtime.lock"));
		try {
			const env = new NodeExecutionEnv({ cwd: options.cwd });
			const storage = await JsonlSessionStorage.create(env, join(sessionDir, "session.jsonl"), {
				cwd: options.cwd,
				sessionId,
			});
			const session = toSession(storage);
			const modelReference = options.model ?? this.options.defaultModel;
			const model = this.resolveModel(modelReference);
			const tools = (await this.options.createTools?.(env)) ?? [];
			const config: PersistedSessionConfigV1 = {
				providerId: model.provider,
				modelId: model.id,
				thinkingLevel: options.thinkingLevel ?? this.options.defaultThinkingLevel ?? "off",
				activeToolNames: tools.map((tool) => tool.name),
			};
			await session.appendCustomEntry(SESSION_CONFIG_CUSTOM_TYPE, config);
			return await this.publishLoaded(sessionId, env, session, lease, model, config, tools);
		} catch (error) {
			await lease.release();
			await rm(sessionDir, { recursive: true, force: true });
			throw normalizeHarnessError(error, "session");
		}
	}

	async open(sessionId: string): Promise<AgentSession<TSkill, TPromptTemplate, TTool>> {
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
				const header = await this.readHeader(sessionPath);
				const fileStat = await stat(sessionPath);
				const loaded = this.loaded.get(header.id)?.session;
				summaries.push({
					id: header.id,
					cwd: header.cwd,
					createdAt: header.timestamp,
					updatedAt: fileStat.mtime.toISOString(),
					loadedState: loaded?.getSnapshot().state ?? "unloaded",
					model: loaded?.getSnapshot().model,
					thinkingLevel: loaded?.getSnapshot().thinkingLevel,
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
		try {
			await loaded.session.close();
		} finally {
			this.loaded.delete(sessionId);
			await loaded.lease.release();
		}
	}

	async delete(sessionId: string): Promise<void> {
		await this.close(sessionId);
		const sessionDir = this.sessionDir(sessionId);
		const lease = await acquireNodeSessionLease(join(sessionDir, "runtime.lock"));
		try {
			await rm(sessionDir, { recursive: true, force: true });
		} finally {
			await lease.release().catch(() => undefined);
		}
	}

	async shutdown(options?: { abortRunning?: boolean }): Promise<void> {
		const sessionIds = [...this.loaded.keys()];
		const errors: Error[] = [];
		for (const sessionId of sessionIds) {
			try {
				const session = this.loaded.get(sessionId)?.session;
				const runId = session?.getSnapshot().currentRunId;
				if (runId && options?.abortRunning) await session!.abort(runId);
				await this.close(sessionId);
			} catch (error) {
				errors.push(toError(error));
			}
		}
		if (errors.length > 0) {
			throw new AggregateError(errors, "SessionHost shutdown completed with errors");
		}
	}

	private async openUnloaded(sessionId: string): Promise<AgentSession<TSkill, TPromptTemplate, TTool>> {
		const sessionDir = this.sessionDir(sessionId);
		const sessionPath = join(sessionDir, "session.jsonl");
		let lease: NodeSessionLease;
		try {
			lease = await acquireNodeSessionLease(join(sessionDir, "runtime.lock"));
		} catch (error) {
			throw normalizeHarnessError(error, error instanceof AgentHarnessError ? error.code : "session");
		}
		try {
			const header = await this.readHeader(sessionPath);
			if (header.id !== sessionId) {
				throw new AgentHarnessError("session", `Session directory ${sessionId} contains Session ${header.id}`);
			}
			const env = new NodeExecutionEnv({ cwd: header.cwd });
			const session = toSession(await JsonlSessionStorage.open(env, sessionPath));
			const entries = await session.getEntries();
			let config: PersistedSessionConfigV1 | undefined;
			for (const entry of entries) {
				if (
					entry.type === "custom" &&
					entry.customType === SESSION_CONFIG_CUSTOM_TYPE &&
					isPersistedConfig(entry.data)
				) {
					config = entry.data;
				}
			}
			const modelReference = config
				? { providerId: config.providerId, modelId: config.modelId }
				: this.options.defaultModel;
			const model = this.resolveModel(modelReference);
			const tools = (await this.options.createTools?.(env)) ?? [];
			const effectiveConfig: PersistedSessionConfigV1 = config ?? {
				providerId: model.provider,
				modelId: model.id,
				thinkingLevel: this.options.defaultThinkingLevel ?? "off",
				activeToolNames: tools.map((tool) => tool.name),
			};
			if (!config) await session.appendCustomEntry(SESSION_CONFIG_CUSTOM_TYPE, effectiveConfig);
			return await this.publishLoaded(sessionId, env, session, lease, model, effectiveConfig, tools);
		} catch (error) {
			await lease.release();
			throw normalizeHarnessError(error, "session");
		}
	}

	private async publishLoaded(
		sessionId: string,
		env: NodeExecutionEnv,
		session: import("../session/session.ts").Session,
		lease: NodeSessionLease,
		model: Model<any>,
		config: PersistedSessionConfigV1,
		tools: TTool[],
	): Promise<AgentSession<TSkill, TPromptTemplate, TTool>> {
		const runtime = await AgentSession.create({
			env,
			session,
			engine: this.engine,
			model,
			thinkingLevel: config.thinkingLevel,
			tools,
			activeToolNames: config.activeToolNames,
			resources: this.options.resources,
			systemPrompt: this.options.systemPrompt,
			streamOptions: this.options.streamOptions,
			steeringMode: this.options.steeringMode,
			followUpMode: this.options.followUpMode,
			persistConfig: async (nextConfig, writer: SessionWriter) => {
				writer.enqueue({ type: "custom", customType: SESSION_CONFIG_CUSTOM_TYPE, data: nextConfig });
			},
			onClose: async () => cleanupSessionResources(sessionId),
		});
		this.loaded.set(sessionId, { session: runtime, lease });
		return runtime;
	}

	private resolveModel(reference: ModelReference): Model<any> {
		const model = this.options.models.getModel(reference.providerId, reference.modelId);
		if (!model) {
			throw new AgentHarnessError("invalid_argument", `Unknown model ${reference.providerId}/${reference.modelId}`);
		}
		return model;
	}

	private sessionDir(sessionId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
			throw new AgentHarnessError("invalid_argument", "Invalid Session ID");
		}
		return join(this.sessionsDir, sessionId);
	}

	private async readHeader(sessionPath: string): Promise<SessionHeader> {
		try {
			const content = await readFile(sessionPath, "utf8");
			const line = content.split("\n").find((candidate) => candidate.trim());
			if (!line) throw new Error("missing header");
			const header = JSON.parse(line) as Partial<SessionHeader>;
			if (
				header.type !== "session" ||
				typeof header.id !== "string" ||
				typeof header.timestamp !== "string" ||
				typeof header.cwd !== "string"
			) {
				throw new Error("invalid header");
			}
			return header as SessionHeader;
		} catch (error) {
			const cause = toError(error);
			if ("code" in cause && cause.code === "ENOENT") {
				throw new AgentHarnessError("session", `Session not found: ${sessionPath}`, cause);
			}
			throw new AgentHarnessError("session", `Failed to read Session header: ${sessionPath}`, cause);
		}
	}
}

export function createNodeSessionHost<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
	TTool extends AgentTool = AgentTool,
>(options: NodeSessionHostOptions<TSkill, TPromptTemplate, TTool>): NodeSessionHost<TSkill, TPromptTemplate, TTool> {
	return new NodeSessionHost(options);
}
