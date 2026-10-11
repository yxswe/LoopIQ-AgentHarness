import { describe, expect, it } from "vitest";
import { parseRpcMessage } from "./index.ts";

const request = {
	jsonrpc: "2.0",
	id: "client-17",
	method: "run/start",
	params: { sessionId: "session-1", submissionId: "submission-1", input: { text: "Hello \u{1F30D}" } },
};
const notification = { jsonrpc: "2.0", method: "runtime/status", params: { state: "ready" } };
const success = { jsonrpc: "2.0", id: "client-17", result: { runId: "run-1" } };
const failure = {
	jsonrpc: "2.0",
	id: "client-17",
	error: { code: -32000, message: "Runtime is offline", data: { reason: "RUNTIME_OFFLINE" } },
};

describe("RPC envelope parsing", () => {
	it.each([
		["request", request],
		["notification", notification],
		["success", success],
		["failure", failure],
		["success", { ...success, result: null }],
		["failure", { ...failure, id: null }],
	])("classifies %s without changing its payload", (kind, message) => {
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind, message });
	});

	it.each(["", "{", '{"jsonrpc": "2.0",}', "undefined"])("rejects malformed JSON: %s", (text) => {
		expect(parseRpcMessage(text)).toEqual({ kind: "invalid", code: -32700 });
	});

	it.each([
		null,
		true,
		17,
		"message",
		[],
		[request],
		{},
		{ ...request, jsonrpc: "1.0" },
		{ ...request, id: 17 },
		{ ...request, id: "" },
		{ ...request, id: null },
		{ ...request, method: "" },
		{ ...request, params: [] },
		{ ...request, params: null },
		{ ...request, params: undefined },
		{ ...request, result: {} },
		{ ...notification, id: null },
		{ ...success, id: null },
		{ ...success, result: undefined },
		{ ...success, error: failure.error },
		{ ...success, method: "run/start" },
		{ ...failure, error: "failed" },
		{ ...failure, error: { code: -32000 } },
		{ ...failure, error: { code: 1.5, message: "Invalid code" } },
		{ ...failure, error: { code: -32000, message: "Failed", stack: "internal" } },
		{ ...success, internal: true },
	])("rejects an invalid or ambiguous envelope: %j", (message) => {
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "invalid", code: -32600 });
	});

	it("keeps reversed responses separate from inbound requests", () => {
		const replies = [
			{ ...success, id: "runtime-42" },
			{ ...failure, id: "runtime-41" },
		];
		const parsed = replies.map((reply) => parseRpcMessage(JSON.stringify(reply)));
		expect(parsed).toEqual([
			{ kind: "success", message: replies[0] },
			{ kind: "failure", message: replies[1] },
		]);
	});

	it("leaves method admission to the endpoint registry", () => {
		const message = { ...request, method: "future/method", params: {} };
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "request", message });
	});
});
