/// <reference types="bun-types" />
import { join, resolve } from "node:path";
import { createDefaultHarness } from "./harness-factory.ts";

const PORT = Number(process.env.DEVUI_PORT ?? 4100);
const MODEL_ID = process.env.DEVUI_MODEL ?? "claude-opus-4.6";
const CWD = process.env.DEVUI_CWD ?? resolve(import.meta.dir, "../../../..");
const DATA_DIR = resolve(import.meta.dir, "../../.data");
const STATIC_DIR = process.env.DEVUI_STATIC_DIR ?? resolve(import.meta.dir, "../../../devui/public");

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

// --- Build the single harness instance up front ---
const { harness, modelId } = await createDefaultHarness({ dataDir: DATA_DIR, cwd: CWD, modelId: MODEL_ID });

// --- SSE broadcast to all connected clients ---
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function broadcast(payload: unknown): void {
	const frame = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	for (const controller of clients) {
		try {
			controller.enqueue(frame);
		} catch {
			clients.delete(controller);
		}
	}
}

// One global subscription: every notification event goes to every client.
harness.subscribe((event) => {
	broadcast(event);
});

function sseResponse(): Response {
	let self: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			self = controller;
			clients.add(controller);
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server_ready", modelId })}\n\n`));
		},
		cancel() {
			clients.delete(self);
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

async function serveStatic(pathname: string): Promise<Response> {
	const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const file = Bun.file(join(STATIC_DIR, rel));
	if (await file.exists()) return new Response(file);
	return new Response("Not found", { status: 404 });
}

Bun.serve({
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		if (url.pathname === "/api/events" && request.method === "GET") {
			return sseResponse();
		}

		if (url.pathname === "/api/prompt" && request.method === "POST") {
			const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
			if (!body || typeof body.text !== "string" || body.text.trim() === "") {
				return new Response(JSON.stringify({ error: "text (non-empty string) required" }), {
					status: 400,
					headers: { "Content-Type": "application/json", ...CORS_HEADERS },
				});
			}
			const text = body.text;
			// Fire and forget: assistant output + lifecycle events flow over SSE.
			harness.prompt(text).catch((error) => {
				broadcast({ type: "server_error", message: error instanceof Error ? error.message : String(error) });
			});
			return new Response(JSON.stringify({ status: "accepted" }), {
				status: 202,
				headers: { "Content-Type": "application/json", ...CORS_HEADERS },
			});
		}

		if (url.pathname === "/api/abort" && request.method === "POST") {
			const result = await harness.abort();
			return new Response(JSON.stringify(result), {
				status: 200,
				headers: { "Content-Type": "application/json", ...CORS_HEADERS },
			});
		}

		return serveStatic(url.pathname);
	},
});

console.log(`[devui] server on http://localhost:${PORT} (model: ${modelId})`);
