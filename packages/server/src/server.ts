/// <reference types="bun-types" />
import { join, resolve } from "node:path";
import type { AgentEventEnvelope, AgentSession, ModelReference } from "@loopiq/agent-core";
import { AgentHarnessError } from "@loopiq/agent-core";
import { createDefaultRuntime } from "./harness-factory.ts";

const PORT = Number(process.env.DEVUI_PORT ?? 4100);
const MODEL_ID = process.env.DEVUI_MODEL ?? "claude-opus-4.6";
const CWD = process.env.DEVUI_CWD ?? resolve(import.meta.dir, "../../..");
const DATA_DIR = resolve(import.meta.dir, "../.data");
const STATIC_DIR = process.env.DEVUI_STATIC_DIR ?? resolve(import.meta.dir, "../../devui/public");

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};
const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;

const { host, defaultSession, modelId } = await createDefaultRuntime({
	dataDir: DATA_DIR,
	cwd: CWD,
	modelId: MODEL_ID,
});
const encoder = new TextEncoder();

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

function sseResponse(session: AgentSession, legacy = false): Response {
	let unsubscribe = () => {};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					unsubscribe();
					controller.close();
				};
				unsubscribe = session.subscribe((rawEnvelope) => {
					if (closed) return;
					if ((controller.desiredSize ?? 1) <= 0) {
						close();
						return;
					}
					const envelope = safeEnvelope(rawEnvelope);
					const payload = legacy ? envelope.event : envelope;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				});
				const ready = legacy
					? { type: "server_ready", modelId }
					: { type: "server_ready", modelId, sessionId: session.id };
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(ready)}\n\n`));
			},
			cancel() {
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

function errorResponse(error: unknown): Response {
	if (error instanceof AgentHarnessError) {
		const status =
			error.code === "busy" || error.code === "invalid_state" ? 409 : error.code === "session_locked" ? 423 : 400;
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

			if (url.pathname === "/api/events" && request.method === "GET") return sseResponse(defaultSession, true);
			if (url.pathname === "/api/prompt" && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
				if (!body || typeof body.text !== "string" || !body.text.trim())
					return json({ error: "text required" }, 400);
				const snapshot = defaultSession.getSnapshot();
				if (snapshot.state === "idle") {
					const handle = defaultSession.startRun({ text: body.text });
					return json({ status: "accepted", sessionId: defaultSession.id, runId: handle.runId }, 202);
				}
				if (!snapshot.currentRunId) throw new AgentHarnessError("invalid_state", "Session has no active run");
				await defaultSession.steer(snapshot.currentRunId, { text: body.text });
				return json({ status: "steered", sessionId: defaultSession.id, runId: snapshot.currentRunId }, 202);
			}
			if (url.pathname === "/api/abort" && request.method === "POST") {
				return json(await defaultSession.abortCurrent());
			}

			if (url.pathname === "/api/sessions" && request.method === "GET") return json(await host.list());
			if (url.pathname === "/api/sessions" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
				const session = await host.create({
					cwd: typeof body.cwd === "string" ? body.cwd : CWD,
					model: parseModelReference(body.model),
					thinkingLevel: typeof body.thinkingLevel === "string" ? (body.thinkingLevel as never) : undefined,
				});
				return json(session.getSnapshot(), 201);
			}

			const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
			if (eventsMatch && request.method === "GET") return sseResponse(await host.open(eventsMatch[1]!));
			const runMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs$/);
			if (runMatch && request.method === "POST") {
				const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
				if (!body || typeof body.text !== "string" || !body.text.trim())
					return json({ error: "text required" }, 400);
				const session = await host.open(runMatch[1]!);
				const handle = session.startRun({ text: body.text });
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
				const session = await host.open(steerMatch[1]!);
				await session.steer(
					steerMatch[2]!,
					{ text: body.text },
					{ interruptCurrentInference: body.interruptCurrentInference === true },
				);
				return json({ status: "accepted" }, 202);
			}
			const abortMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/runs\/([^/]+)\/abort$/);
			if (abortMatch && request.method === "POST") {
				return json(await (await host.open(abortMatch[1]!)).abort(abortMatch[2]!));
			}
			const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
			if (sessionMatch && request.method === "GET") return json((await host.open(sessionMatch[1]!)).getSnapshot());
			if (sessionMatch && request.method === "DELETE") {
				if (sessionMatch[1] === defaultSession.id)
					return json({ error: "Cannot delete the DevUI default Session" }, 409);
				await host.delete(sessionMatch[1]!);
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			}

			return serveStatic(url.pathname);
		} catch (error) {
			return errorResponse(error);
		}
	},
	error: errorResponse,
});

console.log(`[devui] server on http://localhost:${PORT} (model: ${modelId}, session: ${defaultSession.id})`);
