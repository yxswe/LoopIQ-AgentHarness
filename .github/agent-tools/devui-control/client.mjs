// Minimal DevUI client: observe the SSE event stream and POST actions.
// Zero third-party dependencies; runs on Node 22+ or Bun (global fetch + web streams).
//
// The devui server (packages/server) exposes a single shared AgentHarness over:
//   GET  /api/events  -> SSE broadcast of every AgentNotificationEvent (+ server_ready/server_error)
//   POST /api/prompt  -> { text }  (fire-and-forget; output flows over SSE)
//   POST /api/abort   -> abort the running turn
// This client is the agent-facing counterpart to the browser devui: it drives and
// observes the *same* shared session, so anything the skill sends also shows up on devui.

const DEFAULT_URL = process.env.DEVUI_URL || `http://localhost:${process.env.DEVUI_PORT || 4100}`;

/** Base server URL without a trailing slash. */
export function baseUrl() {
	return DEFAULT_URL.replace(/\/+$/, "");
}

/** POST helper. `body` is JSON-encoded when provided. */
export function post(path, body) {
	return fetch(baseUrl() + path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

/**
 * Open the SSE stream and yield parsed events until the signal aborts or the
 * connection closes. The first yielded event is normally `server_ready`.
 */
export async function* events(signal) {
	const res = await fetch(baseUrl() + "/api/events", {
		headers: { Accept: "text/event-stream" },
		signal,
	});
	if (!res.ok || !res.body) throw new Error(`events stream failed: ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) return;
		buf += decoder.decode(value, { stream: true });
		let idx;
		// SSE frames are separated by a blank line.
		while ((idx = buf.indexOf("\n\n")) !== -1) {
			const frame = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			try {
				yield JSON.parse(data);
			} catch {
				// Ignore malformed frames.
			}
		}
	}
}

/** Extract plain text from an AgentMessage's content (string or content-part array). */
export function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
	}
	return "";
}
