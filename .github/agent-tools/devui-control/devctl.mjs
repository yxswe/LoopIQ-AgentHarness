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

import { baseUrl, events, messageText, post, runtime, sessionSnapshot } from "./client.mjs";

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
	let runtimeInfo;
	let snapshot;
	try {
		runtimeInfo = await runtime();
		snapshot = await sessionSnapshot(runtimeInfo.defaultSessionId);
	} catch (error) {
		fail(`cannot discover devui runtime: ${error.message}\n${serverHint()}`);
	}
	const sessionId = runtimeInfo.defaultSessionId;

	const ac = new AbortController();
	const stream = events(sessionId, ac.signal);

	// Establish the SSE connection first (first event is server_ready) so we are
	// registered as a client before the prompt fires and don't miss early events.
	let first;
	try {
		first = await stream.next();
	} catch (error) {
		fail(`cannot reach devui server: ${error.message}\n${serverHint()}`);
	}
	if (first.done) fail(`event stream closed before it started.\n${serverHint()}`);

	let runId = snapshot.currentRunId;
	const path = runId
		? `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/steer`
		: `/api/sessions/${encodeURIComponent(sessionId)}/runs`;
	const res = await post(path, { text }).catch((error) => {
		fail(`prompt request failed: ${error.message}\n${serverHint()}`);
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		fail(`prompt failed: ${res.status} ${detail}`);
	}
	if (!runId) {
		const accepted = await res.json().catch(() => ({}));
		runId = accepted.runId;
		if (!runId) fail("prompt accepted without a runId");
	}

	let finalText = "";
	for await (const envelope of stream) {
		if (envelope.type === "server_ready") continue;
		if (envelope.runId && envelope.runId !== runId) continue;
		const event = envelope.event;
		if (!event) continue;
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
		}
		if (event.type === "run_settled") {
			ac.abort();
			break;
		}
	}

	process.stdout.write(finalText.endsWith("\n") ? finalText : `${finalText}\n`);
}

async function cmdAbort() {
	let runtimeInfo;
	let snapshot;
	try {
		runtimeInfo = await runtime();
		snapshot = await sessionSnapshot(runtimeInfo.defaultSessionId);
	} catch (error) {
		fail(`cannot discover devui runtime: ${error.message}\n${serverHint()}`);
	}
	if (!snapshot.currentRunId) fail("abort failed: the devui Session has no active run");
	const path = `/api/sessions/${encodeURIComponent(runtimeInfo.defaultSessionId)}/runs/${encodeURIComponent(snapshot.currentRunId)}/abort`;
	const res = await post(path).catch((error) => {
		fail(`abort request failed: ${error.message}\n${serverHint()}`);
	});
	if (!res.ok) fail(`abort failed: ${res.status}`);
	const json = await res.json().catch(() => ({}));
	console.log(JSON.stringify(json));
}

async function cmdWatch() {
	let runtimeInfo;
	try {
		runtimeInfo = await runtime();
	} catch (error) {
		fail(`cannot discover devui runtime: ${error.message}\n${serverHint()}`);
	}
	const ac = new AbortController();
	process.on("SIGINT", () => {
		ac.abort();
		process.exit(0);
	});
	try {
		for await (const envelope of events(runtimeInfo.defaultSessionId, ac.signal)) {
			const event = envelope.event ?? envelope;
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
