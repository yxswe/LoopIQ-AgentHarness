/// <reference types="bun-types" />
import { join, resolve } from "node:path";
import type {
	Agent,
	AgentConfigurationUpdate,
	AgentEventEnvelope,
	ModelReference,
	ProviderAuthMethod,
	ProviderRequestPolicy,
	ThinkingLevel,
} from "@loopiq/agent";
import { AgentRuntimeError } from "@loopiq/agent";
import { ProviderCredentialJobs } from "./provider-credential-jobs.ts";
import { createDefaultRuntime } from "./runtime-factory.ts";

const PORT = Number(process.env.DEVUI_PORT ?? 4100);
const CWD = process.env.DEVUI_CWD ?? resolve(import.meta.dir, "../../..");
const DATA_DIR = resolve(import.meta.dir, "../.data");
const STATIC_DIR = process.env.DEVUI_STATIC_DIR ?? resolve(import.meta.dir, "../../devui/public");

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;

const { agent, defaultSessionId, model } = await createDefaultRuntime({
	dataDir: DATA_DIR,
	cwd: CWD,
	defaultModel: process.env.DEVUI_MODEL ? parseModelReference(process.env.DEVUI_MODEL) : undefined,
});
const encoder = new TextEncoder();
const credentialJobs = new ProviderCredentialJobs();

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function safeEnvelope(envelope: AgentEventEnvelope): AgentEventEnvelope {
	if (envelope.event.type !== "after_provider_response") return envelope;
	return {
		...envelope,
		event: {
			...envelope.event,
			headers: Object.fromEntries(
				Object.entries(envelope.event.headers).map(([name, value]) => [
					name,
					SENSITIVE_HEADER.test(name) ? "[redacted]" : value,
				]),
			),
		},
	};
}

function sseResponse(agent: Agent, sessionId: string): Response {
	let unsubscribe = () => {};
	let closed = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			async start(controller) {
				const close = () => {
					if (closed) return;
					closed = true;
					unsubscribe();
					controller.close();
				};
				const stop = await agent.subscribe(sessionId, (rawEnvelope) => {
					if (closed) return;
					if ((controller.desiredSize ?? 1) <= 0) {
						close();
						return;
					}
					const envelope = safeEnvelope(rawEnvelope);
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`));
				});
				if (closed) {
					stop();
					return;
				}
				unsubscribe = stop;
				const ready = { type: "server_ready", model, sessionId };
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(ready)}\n\n`));
			},
			cancel() {
				closed = true;
				unsubscribe();
			},
		},
		{ highWaterMark: 256 },
	);
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...CORS_HEADERS,
		},
	});
}

function credentialJobSseResponse(jobId: string): Response | undefined {
	if (!credentialJobs.has(jobId)) return undefined;
	let unsubscribe = () => {};
	let closed = false;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const stop = credentialJobs.subscribe(jobId, (event) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				if (event.type === "completed" || event.type === "failed" || event.type === "canceled") {
					closed = true;
					controller.close();
				}
			});
			if (!stop) {
				closed = true;
				controller.close();
				return;
			}
			unsubscribe = stop;
			if (closed) stop();
		},
		cancel() {
			closed = true;
			unsubscribe();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			...CORS_HEADERS,
		},
	});
}

function errorResponse(error: unknown): Response {
	if (error instanceof AgentRuntimeError) {
		const status =
			error.code === "busy" || error.code === "provider_busy" || error.code === "invalid_state"
				? 409
				: error.code === "session_locked"
					? 423
					: 400;
		return json({ error: error.message, code: error.code }, status);
	}
	return json({ error: error instanceof Error ? error.message : String(error) }, 500);
}

function parseModelReference(value: unknown): ModelReference | undefined {
	if (typeof value !== "string") return undefined;
	const separator = value.indexOf("/");
	if (separator <= 0 || separator === value.length - 1) return undefined;
	return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

async function serveStatic(pathname: string): Promise<Response> {
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const file = Bun.file(join(STATIC_DIR, relative));
	if (await file.exists()) return new Response(file);
	return new Response("Not found", { status: 404 });
}

Bun.serve({
	port: PORT,
	async fetch(request) {
		try {
			const url = new URL(request.url);
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

			if (url.pathname === "/api/runtime" && request.method === "GET") {
				return json({ model, defaultSessionId, configuration: await agent.getConfiguration() });
			}

			if (url.pathname === "/api/configuration" && request.method === "GET") {
				return json(await agent.getConfiguration());
			}
			if (url.pathname === "/api/configuration" && request.method === "PATCH") {
				const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
				if (!body || Array.isArray(body)) return json({ error: "configuration update must be an object" }, 400);
				const update: AgentConfigurationUpdate = {};
				if (body.defaultModel !== undefined) {
					const defaultModel = parseModelReference(body.defaultModel);
					if (!defaultModel) return json({ error: "defaultModel must use provider/model format" }, 400);
					update.defaultModel = defaultModel;
				}
				if (body.defaultThinkingLevel !== undefined) {
					if (
						typeof body.defaultThinkingLevel !== "string" ||
						!["off", "minimal", "low", "medium", "high", "xhigh"].includes(body.defaultThinkingLevel)
					) {
						return json({ error: "defaultThinkingLevel is invalid" }, 400);
					}
					update.defaultThinkingLevel = body.defaultThinkingLevel as ThinkingLevel;
				}
				if (body.providerRequest !== undefined) {
					if (
						!body.providerRequest ||
						typeof body.providerRequest !== "object" ||
						Array.isArray(body.providerRequest)
					) {
						return json({ error: "providerRequest must be an object" }, 400);
					}
					update.providerRequest = body.providerRequest as Partial<ProviderRequestPolicy>;
				}
				return json(await agent.updateConfiguration(update));
			}

			if (url.pathname === "/api/providers" && request.method === "GET") {
				return json(
					await agent.listProviders({ validateCredentials: url.searchParams.get("validate") === "true" }),
				);
			}
			const providerModelsMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/models$/);
			if (providerModelsMatch && request.method === "GET") {
				return json(
					await agent.listModels(providerModelsMatch[1]!, { refresh: url.searchParams.get("refresh") === "true" }),
				);
			}
			const providerCredentialMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/credential$/);
			if (providerCredentialMatch && request.method === "DELETE") {
				await agent.removeProviderCredential(providerCredentialMatch[1]!);
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}
			if (providerCredentialMatch && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { method?: unknown } | null;
				if (body?.method !== "api_token" && body?.method !== "oauth") {
					return json({ error: "method must be api_token or oauth" }, 400);
				}
				const jobId = credentialJobs.start(agent, providerCredentialMatch[1]!, body.method as ProviderAuthMethod);
				return json({ jobId }, 202);
			}

			const credentialEventsMatch = url.pathname.match(/^\/api\/provider-credential-jobs\/([^/]+)\/events$/);
			if (credentialEventsMatch && request.method === "GET") {
				return (
					credentialJobSseResponse(credentialEventsMatch[1]!) ?? json({ error: "Credential job not found" }, 404)
				);
			}
			const credentialRespondMatch = url.pathname.match(/^\/api\/provider-credential-jobs\/([^/]+)\/respond$/);
			if (credentialRespondMatch && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { promptId?: unknown; value?: unknown } | null;
				if (typeof body?.promptId !== "string" || typeof body.value !== "string") {
					return json({ error: "promptId and value are required" }, 400);
				}
				return credentialJobs.respond(credentialRespondMatch[1]!, body.promptId, body.value)
					? json({ status: "accepted" }, 202)
					: json({ error: "Credential prompt not found" }, 404);
			}
			const credentialJobMatch = url.pathname.match(/^\/api\/provider-credential-jobs\/([^/]+)$/);
			if (credentialJobMatch && request.method === "DELETE") {
				return credentialJobs.cancel(credentialJobMatch[1]!)
					? json({ status: "canceled" })
					: json({ error: "Active credential job not found" }, 404);
			}

			if (url.pathname === "/api/sessions" && request.method === "GET") return json(await agent.listSessions());
			if (url.pathname === "/api/sessions" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
				const session = await agent.createSession({
					cwd: typeof body.cwd === "string" ? body.cwd : CWD,
					model: parseModelReference(body.model),
					thinkingLevel: typeof body.thinkingLevel === "string" ? (body.thinkingLevel as never) : undefined,
				});
				return json(session, 201);
			}

			const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
			if (eventsMatch && request.method === "GET") return sseResponse(agent, eventsMatch[1]!);
			const runMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/);
			if (runMatch && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
				if (!body || typeof body.text !== "string" || !body.text.trim())
					return json({ error: "text required" }, 400);
				const handle = await agent.run(runMatch[1]!, { text: body.text });
				return json({ sessionId: handle.sessionId, runId: handle.runId }, 202);
			}
			const steerMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/steer$/);
			if (steerMatch && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as {
					text?: unknown;
					interruptCurrentInference?: unknown;
				} | null;
				if (!body || typeof body.text !== "string" || !body.text.trim())
					return json({ error: "text required" }, 400);
				await agent.steer(
					steerMatch[1]!,
					steerMatch[2]!,
					{ text: body.text },
					{ interruptCurrentInference: body.interruptCurrentInference === true },
				);
				return json({ status: "accepted" }, 202);
			}
			const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/abort$/);
			if (abortMatch && request.method === "POST") {
				return json(await agent.abort(abortMatch[1]!, abortMatch[2]!));
			}
			const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
			if (sessionMatch && request.method === "GET") return json(await agent.getSession(sessionMatch[1]!));
			if (sessionMatch && request.method === "PATCH") {
				const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
				const nextModel = body.model === undefined ? undefined : parseModelReference(body.model);
				if (body.model !== undefined && !nextModel)
					return json({ error: "model must use provider/model format" }, 400);
				return json(
					await agent.updateSession(sessionMatch[1]!, {
						model: nextModel,
						thinkingLevel: typeof body.thinkingLevel === "string" ? (body.thinkingLevel as never) : undefined,
					}),
				);
			}
			if (sessionMatch && request.method === "DELETE") {
				if (sessionMatch[1] === defaultSessionId)
					return json({ error: "Cannot delete the DevUI default Session" }, 409);
				await agent.deleteSession(sessionMatch[1]!);
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			return serveStatic(url.pathname);
		} catch (error) {
			return errorResponse(error);
		}
	},
	error: errorResponse,
});

console.log(
	`[devui] server on http://localhost:${PORT} (model: ${model.providerId}/${model.modelId}, session: ${defaultSessionId})`,
);
