const statusEl = document.getElementById("status");
const modelEl = document.getElementById("model");
const chatEl = document.getElementById("chat");
const traceEl = document.getElementById("trace");
const form = document.getElementById("form");
const input = document.getElementById("input");

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
		modelEl.textContent = `model: ${event.modelId}`;
		return;
	}
	if (event.type === "server_error") {
		addBubble("error", event.message);
		assistantBubble = null;
		return;
	}

	const message = event.message;
	const role = message?.role;

	if (event.type === "message_start" && role === "assistant") {
		assistantBubble = addBubble("assistant", "");
		return;
	}
	if (event.type === "message_update" && role === "assistant") {
		if (!assistantBubble) assistantBubble = addBubble("assistant", "");
		assistantBubble.textContent = messageText(message);
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
	const source = new EventSource("/api/events");
	source.onopen = () => statusEl.className = "status connected";
	source.onerror = () => statusEl.className = "status error";
	source.onmessage = (e) => {
		try {
			handleEvent(JSON.parse(e.data));
		} catch (err) {
			console.error("bad event", e.data, err);
		}
	};
}

form.addEventListener("submit", async (e) => {
	e.preventDefault();
	const text = input.value.trim();
	if (!text) return;
	addBubble("user", text);
	input.value = "";
	const res = await fetch("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	if (!res.ok) addBubble("error", `prompt failed: ${res.status}`);
});

document.getElementById("abort").addEventListener("click", () => {
	fetch("/api/abort", { method: "POST" });
});

connect();
