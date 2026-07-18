#!/usr/bin/env node
// devctl - agent-facing control CLI for the devui server.
//
// Commands:
//   devctl send "<text>"   Send a prompt, block until the turn settles, print the assistant's final reply.
//   devctl abort           Abort the running turn (same as the devui Abort button).
//   devctl watch           Stream every event (chat + debug) to stdout until Ctrl-C.
//
// Server URL comes from DEVUI_URL, or DEVUI_PORT (default http://localhost:4100).
// The skill drives the SAME shared session the browser devui shows, so sends also
// appear on devui as user bubbles.

import { baseUrl, events, messageText, post } from "./client.mjs";

function fail(message, code = 1) {
	console.error(message);
	process.exit(code);
}

function serverHint() {
	return `Is the devui server running at ${baseUrl()}? Start it from the repo root with:\n  npm run devui`;
}

// Send a prompt and block until `agent_end`, then print the assistant's final text.
async function cmdSend(text) {
	if (!text || !text.trim()) fail('usage: devctl send "<text>"');

	const ac = new AbortController();
	const stream = events(ac.signal);

	// Establish the SSE connection first (first event is server_ready) so we are
	// registered as a client before the prompt fires and don't miss early events.
	let first;
	try {
		first = await stream.next();
	} catch (error) {
		fail(`cannot reach devui server: ${error.message}\n${serverHint()}`);
	}
	if (first.done) fail(`event stream closed before it started.\n${serverHint()}`);

	const res = await post("/api/prompt", { text }).catch((error) => {
		fail(`prompt request failed: ${error.message}\n${serverHint()}`);
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		fail(`prompt failed: ${res.status} ${detail}`);
	}

	let finalText = "";
	for await (const event of stream) {
		if (event.type === "server_error") {
			ac.abort();
			fail(`server_error: ${event.message}`);
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			finalText = messageText(event.message);
		}
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? event.messages : [];
			const lastAssistant = [...messages].reverse().find((m) => m?.role === "assistant");
			if (lastAssistant) finalText = messageText(lastAssistant);
			ac.abort();
			break;
		}
	}

	process.stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`);
}

async function cmdAbort() {
	const res = await post("/api/abort").catch((error) => {
		fail(`abort request failed: ${error.message}\n${serverHint()}`);
	});
	if (!res.ok) fail(`abort failed: ${res.status}`);
	const json = await res.json().catch(() => ({}));
	console.log(JSON.stringify(json));
}

async function cmdWatch() {
	const ac = new AbortController();
	process.on("SIGINT", () => {
		ac.abort();
		process.exit(0);
	});
	try {
		for await (const event of events(ac.signal)) {
			const { type, ...rest } = event;
			const detail = JSON.stringify(rest);
			console.log(detail === "{}" ? type : `${type} ${detail}`);
		}
	} catch (error) {
		if (ac.signal.aborted) return;
		fail(`watch failed: ${error.message}\n${serverHint()}`);
	}
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case "send":
			await cmdSend(rest.join(" "));
			break;
		case "abort":
			await cmdAbort();
			break;
		case "watch":
			await cmdWatch();
			break;
		default:
			fail("usage: devctl <send|abort|watch> [text]");
	}
}

main();
