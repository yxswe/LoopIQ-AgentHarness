const statusEl = document.getElementById("status");
const modelEl = document.getElementById("model");
const chatEl = document.getElementById("chat");
const traceEl = document.getElementById("trace");
const form = document.getElementById("form");
const input = document.getElementById("input");
let sessionId = null;
let currentRunId = null;
const settledRunIds = new Set();

function modelLabel(model) {
	return model?.providerId && model?.modelId ? `${model.providerId}/${model.modelId}` : "unknown";
}

/** Extract plain text from an AgentMessage's content (string or content-part array). */
function messageText(message) {
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

function addBubble(role, text) {
	const el = document.createElement("div");
	el.className = `bubble ${role}`;
	el.textContent = text;
	chatEl.appendChild(el);
	chatEl.scrollTop = chatEl.scrollHeight;
	return el;
}

function addTrace(event) {
	const el = document.createElement("div");
	const isError = event.type === "server_error" || event.type === "error" || event.type === "abort";
	el.className = `trace-item${isError ? " error" : ""}`;
	const type = document.createElement("span");
	type.className = "type";
	type.textContent = event.type;
	el.appendChild(type);
	const rest = { ...event };
	delete rest.type;
	const detail = document.createElement("span");
	detail.textContent = ` ${JSON.stringify(rest)}`.slice(0, 300);
	el.appendChild(detail);
	traceEl.appendChild(el);
	traceEl.scrollTop = traceEl.scrollHeight;
}

// Current assistant bubble being streamed (keyed by nothing; single active turn).
let assistantBubble = null;

function handleEvent(event) {
	addTrace(event);

	if (event.type === "server_ready") {
		modelEl.textContent = `model: ${modelLabel(event.model)}`;
		return;
	}
	if (event.type === "server_error") {
		addBubble("error", event.message);
		assistantBubble = null;
		return;
	}
	if (event.type === "run_settled") {
		if (event.status === "failed") addBubble("error", event.error?.message ?? "run failed");
		return;
	}

	const message = event.message;
	const role = message?.role;

	// User bubbles are driven by the event stream (single source of truth), so
	// prompts submitted by any client -- the browser form or an external agent
	// via the devui-control skill -- render identically here.
	if (event.type === "message_start" && role === "user") {
		addBubble("user", messageText(message));
		return;
	}

	if (event.type === "message_start" && role === "assistant") {
		assistantBubble = addBubble("assistant", "");
		return;
	}
	if (event.type === "message_update" && event.update.type === "text_delta") {
		if (!assistantBubble) assistantBubble = addBubble("assistant", "");
		assistantBubble.textContent += event.update.delta;
		chatEl.scrollTop = chatEl.scrollHeight;
		return;
	}
	if (event.type === "message_end" && role === "assistant") {
		if (assistantBubble) assistantBubble.textContent = messageText(message);
		assistantBubble = null;
		return;
	}
}

function connect() {
	const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
	source.onopen = () => statusEl.className = "status connected";
	source.onerror = () => statusEl.className = "status error";
	source.onmessage = (e) => {
		try {
			const payload = JSON.parse(e.data);
			if (payload.type === "server_ready") handleEvent(payload);
			else if (payload.event) {
				if (payload.event.type === "run_settled") {
					settledRunIds.add(payload.runId);
					if (currentRunId === payload.runId) currentRunId = null;
				} else if (payload.runId) currentRunId = payload.runId;
				handleEvent(payload.event);
			}
		} catch (err) {
			console.error("bad event", e.data, err);
		}
	};
}

async function bootstrap() {
	const runtimeResponse = await fetch("/api/runtime");
	if (!runtimeResponse.ok) throw new Error(`runtime discovery failed: ${runtimeResponse.status}`);
	const runtime = await runtimeResponse.json();
	sessionId = runtime.defaultSessionId;
	modelEl.textContent = `model: ${modelLabel(runtime.model)}`;
	const snapshotResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
	if (!snapshotResponse.ok) throw new Error(`session discovery failed: ${snapshotResponse.status}`);
	const snapshot = await snapshotResponse.json();
	currentRunId = snapshot.currentRunId ?? null;
	connect();
}

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const text = input.value.trim();
	if (!text) return;
	if (!sessionId) {
		addBubble("error", "runtime is not ready");
		return;
	}
	input.value = "";
	// The user bubble is rendered from the message_start(user) event (see
	// handleEvent), not optimistically here, so browser and agent prompts match.
	const targetRunId = currentRunId;
	const path = targetRunId
		? `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(targetRunId)}/steer`
		: `/api/sessions/${encodeURIComponent(sessionId)}/runs`;
	const res = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (!res.ok) {
		addBubble("error", `prompt failed: ${res.status}`);
		return;
	}
	if (!targetRunId) {
		const accepted = await res.json();
		if (settledRunIds.has(accepted.runId)) settledRunIds.delete(accepted.runId);
		else currentRunId = accepted.runId;
	}
});

document.getElementById("abort").addEventListener("click", () => {
	if (!sessionId || !currentRunId) return;
	fetch(
		`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(currentRunId)}/abort`,
		{ method: "POST" },
	);
});

bootstrap().catch((error) => {
	statusEl.className = "status error";
	addBubble("error", error.message);
});
