import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { parseRpcMessage, RpcErrorSchema } from "./index.ts";

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

describe("v1 RPC errors", () => {
	it.each([-32700, -32600, -32601, -32602])("round-trips protocol error %s with either correlation form", (code) => {
		const error = { code, message: "Invalid request" };
		expect(Check(RpcErrorSchema, error)).toBe(true);
		for (const id of ["attempt-1", null]) {
			const message = { jsonrpc: "2.0", id, error };
			expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "failure", message });
		}
	});

	it.each([
		"NOT_INITIALIZED",
		"UNAUTHORIZED",
		"VERSION_UNSUPPORTED",
		"RUNTIME_ALREADY_CONNECTED",
		"RUNTIME_OFFLINE",
		"RUNTIME_SYNCING",
		"SESSION_BUSY",
		"CAPACITY_EXCEEDED",
		"STALE_RUN",
		"RUN_NOT_SETTLED",
		"SUBMISSION_CONFLICT",
		"CREATION_CONFLICT",
		"CONFIGURATION_INVALID",
		"SESSION_NOT_FOUND",
		"SESSION_DELETED",
		"WORKSPACE_INVALID",
		"SESSION_LOCKED",
		"STORAGE_UNAVAILABLE",
		"RECOVERY_REQUIRED",
		"SNAPSHOT_TOO_LARGE",
		"INPUT_TOO_LARGE",
		"OBSERVATION_EXPIRED",
		"INTERACTION_UNSUPPORTED",
	])("round-trips the public business reason %s", (reason) => {
		const error = { code: -32000, message: "Request rejected", data: { reason } };
		const message = { jsonrpc: "2.0", id: "attempt-1", error };
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "failure", message });
		expect(Check(RpcErrorSchema, JSON.parse(JSON.stringify(error)))).toBe(true);
	});

	it.each([
		{ code: -32000, message: "Missing reason" },
		{ code: -32000, message: "Lost reply", data: { reason: "TIMEOUT" } },
		{ code: -32000, message: "Lost reply", data: { reason: "DISCONNECTED" } },
		{ code: -32000, message: "Failed", data: { reason: "FAILED" } },
		{ ...failure.error, data: { reason: "SESSION_BUSY", headers: { authorization: "fixture" } } },
		{ ...failure.error, stack: "Internal trace" },
		{ ...failure.error, delivery: "uncertain" },
		{ code: -32602, message: "Wrong error family", data: { reason: "SESSION_BUSY" } },
		{ code: 17, message: "Unknown code" },
		{ code: -32700, message: 42 },
		new Error("Internal exception"),
	])("rejects invalid or internal error data: %j", (error) => {
		expect(Check(RpcErrorSchema, error)).toBe(false);
	});

	it("requires strict error validation after generic envelope parsing", () => {
		const message = { ...failure, error: { code: -32000, message: "Failed", data: { reason: "TIMEOUT" } } };
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "failure", message });
		expect(Check(RpcErrorSchema, message.error)).toBe(false);
	});
});
