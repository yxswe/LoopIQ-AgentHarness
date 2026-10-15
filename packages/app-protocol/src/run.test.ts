import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	HistoryItemSchema,
	isMethodAllowed,
	parseRpcMessage,
	RUN_METHOD_SCHEMAS,
	type RunIdentity,
	RunLookupSchema,
	type RunMethodMap,
	type RunResultView,
	RunResultViewSchema,
	RunViewSchema,
	type SettledRunView,
} from "./index.ts";

const identity: RunIdentity = {
	sessionId: "019a0665-dc18-7000-8000-000000000001",
	runId: "019a0665-dc18-7000-8000-000000000002",
	submissionId: "019a0665-dc18-7000-8000-000000000003",
};
const ref = { sessionId: identity.sessionId, runId: identity.runId };
const settled: SettledRunView = {
	...identity,
	state: "settled",
	outcome: { status: "completed" },
	completedAt: "2026-10-14T12:00:00.000Z",
};
const item = {
	itemId: "legacy-message-id",
	revision: 0,
	runId: identity.runId,
	kind: "assistantMessage" as const,
	timestamp: settled.completedAt,
	content: "Result: 你好 🌍",
};
const result: RunResultView = {
	run: settled,
	finalItems: [item],
	itemIds: [item.itemId],
	details: { terminationReason: "stop", usage: { completeness: "unavailable" } },
};
const calls: { [M in keyof RunMethodMap]: { method: M } & RunMethodMap[M] }[keyof RunMethodMap][] = [
	{
		method: "run/start",
		params: { sessionId: identity.sessionId, submissionId: identity.submissionId, text: "  你好\n" },
		result: identity,
	},
	{ method: "run/read", params: ref, result: { kind: "known", run: settled } },
	{
		method: "run/read",
		params: { sessionId: identity.sessionId, submissionId: identity.submissionId },
		result: { kind: "notAccepted" },
	},
	{ method: "run/result", params: ref, result },
	{ method: "run/steer", params: { ...ref, text: "Continue", interruptCurrentInference: true }, result: {} },
	{ method: "run/abort", params: ref, result: settled },
];

describe("Run method contracts", () => {
	it.each(calls)("round-trips $method on both command hops", ({ method, params, result }) => {
		for (const id of ["client-attempt", "backend-attempt"]) {
			const request = { jsonrpc: "2.0", id, method, params };
			const reply = { jsonrpc: "2.0", id, result };
			expect(parseRpcMessage(JSON.stringify(request))).toEqual({ kind: "request", message: request });
			expect(parseRpcMessage(JSON.stringify(reply))).toEqual({ kind: "success", message: reply });
			expect(Check(RUN_METHOD_SCHEMAS[method].params, JSON.parse(JSON.stringify(params)))).toBe(true);
			expect(Check(RUN_METHOD_SCHEMAS[method].result, JSON.parse(JSON.stringify(result)))).toBe(true);
		}
		for (const direction of ["frontendToServer", "serverToRuntime"] as const) {
			expect(isMethodAllowed(direction, "request", method)).toBe(true);
			expect(isMethodAllowed(direction, "notification", method)).toBe(false);
		}
		for (const direction of ["runtimeToServer", "serverToFrontend"] as const) {
			expect(isMethodAllowed(direction, "request", method)).toBe(false);
		}
	});

	it.each([
		["run/read", { sessionId: identity.sessionId }],
		["run/read", identity],
		["run/read", { ...ref, runId: "" }],
		["run/start", { ...calls[0].params, submissionId: "submission-1" }],
		["run/start", { ...calls[0].params, text: "" }],
		["run/start", { ...calls[0].params, text: { image: "unsupported" } }],
		["run/start", { ...calls[0].params, runId: identity.runId }],
		["run/steer", { sessionId: identity.sessionId, text: "Continue" }],
		["run/steer", { ...ref, text: "Continue", interruptCurrentInference: "true" }],
		["run/abort", { sessionId: identity.sessionId, submissionId: identity.submissionId }],
		["run/abort", { ...ref, runId: null }],
		["run/result", { ...ref, sessionId: `urn:uuid:${identity.sessionId}` }],
		["run/result", { ...ref, sessionId: `${identity.sessionId}\n` }],
		["run/result", { ...ref, runtimeServiceId: identity.sessionId }],
	] as const)("rejects invalid %s parameters: %j", (method, params) => {
		expect(Check(RUN_METHOD_SCHEMAS[method].params, params)).toBe(false);
	});

	it("keeps start identity, steering acknowledgment and abort settlement distinct", () => {
		expect(Check(RUN_METHOD_SCHEMAS["run/start"].result, settled)).toBe(false);
		for (const value of [null, { queued: true }, identity]) {
			expect(Check(RUN_METHOD_SCHEMAS["run/steer"].result, value)).toBe(false);
		}
		expect(Check(RUN_METHOD_SCHEMAS["run/steer"].params, { ...ref, text: "Continue" })).toBe(true);
		expect(Check(RUN_METHOD_SCHEMAS["run/abort"].result, { ...identity, state: "settling" })).toBe(false);
		expectTypeOf<RunMethodMap["run/start"]["result"]>().toEqualTypeOf<RunIdentity>();
		expectTypeOf<RunMethodMap["run/abort"]["result"]>().toEqualTypeOf<SettledRunView>();
	});
});

describe("Run knowledge and outcomes", () => {
	it.each(["accepted", "running", "settling"])("preserves known nonterminal state %s", (state) => {
		expect(Check(RunLookupSchema, { kind: "known", run: { ...identity, state } })).toBe(true);
	});
	it.each([
		{ status: "completed" },
		{ status: "aborted" },
		{ status: "interrupted" },
		{ status: "failed", error: { code: "EXECUTION_FAILED", message: "Execution failed" } },
	])("preserves actual terminal outcome %j in reads, aborts and results", (outcome) => {
		const run = JSON.parse(JSON.stringify({ ...settled, outcome }));
		expect(Check(RunLookupSchema, { kind: "known", run })).toBe(true);
		expect(Check(RUN_METHOD_SCHEMAS["run/abort"].result, run)).toBe(true);
		expect(Check(RunResultViewSchema, { ...result, run, finalItems: [], itemIds: [] })).toBe(true);
	});
	it.each([
		{ kind: "notAccepted" },
		{ kind: "unknown", reason: "recordsUnavailable" },
		{ kind: "unknown", reason: "legacyHistory" },
	])("round-trips lookup knowledge without inventing a Run: %j", (lookup) => {
		expect(Check(RunLookupSchema, JSON.parse(JSON.stringify(lookup)))).toBe(true);
		expect(Check(RunViewSchema, lookup)).toBe(false);
	});
	it.each([
		{ kind: "unknown" },
		{ kind: "unknown", reason: "timeout" },
		{ kind: "notAccepted", run: settled },
		{ kind: "known" },
	])("rejects ambiguous lookup knowledge: %j", (lookup) => expect(Check(RunLookupSchema, lookup)).toBe(false));
	it.each([
		{ ...identity, state: "uncertain" },
		{ ...identity, state: "busy" },
		{ ...identity, state: "accepted", outcome: { status: "completed" } },
		{ ...identity, state: "running", completedAt: settled.completedAt },
		{ ...identity, state: "settled" },
		{ ...settled, completedAt: "yesterday" },
		{ ...settled, outcome: { status: "failed" } },
		{ ...settled, outcome: { status: "timeout" } },
		{ ...settled, outcome: { status: "completed", error: { code: "X", message: "X" } } },
		{ ...settled, outcome: { status: "failed", error: { code: "X", message: "X", stack: "internal" } } },
	])("rejects malformed or contradictory Run state: %j", (run) => expect(Check(RunViewSchema, run)).toBe(false));
	it.each(["SESSION_BUSY", "RUN_NOT_SETTLED"])(
		"keeps %s in an RPC failure, outside successful Run payloads",
		(reason) => {
			const error = { code: -32000, message: "Request rejected", data: { reason } };
			const message = { jsonrpc: "2.0", id: "attempt", error };
			expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "failure", message });
			for (const { result } of Object.values(RUN_METHOD_SCHEMAS)) expect(Check(result, error)).toBe(false);
		},
	);
});

describe("retained display results", () => {
	it.each(["userMessage", "assistantMessage", "toolCall", "toolResult"])(
		"preserves legacy null Run association for %s",
		(kind) => {
			const legacy = { ...item, kind, runId: null, toolCallId: "provider-call-id", content: "" };
			expect(Check(HistoryItemSchema, JSON.parse(JSON.stringify(legacy)))).toBe(true);
		},
	);
	it.each([
		{ completeness: "complete", inputTokens: 3, outputTokens: 2 },
		{ completeness: "partial", inputTokens: 3 },
		{ completeness: "unavailable" },
	])("preserves usage coverage without defaulting missing counts: %j", (usage) => {
		for (const terminationReason of ["stop", "outputLimit", "abort", "error", "unknown"]) {
			const copy = JSON.parse(JSON.stringify({ ...result, details: { terminationReason, usage } }));
			expect(Check(RunResultViewSchema, copy)).toBe(true);
			expect(copy.details.usage).toEqual(usage);
		}
	});
	it.each([
		{ ...item, revision: -1 },
		{ ...item, revision: 0.5 },
		{ ...item, revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...item, runId: undefined },
		{ ...item, itemId: "" },
		{ ...item, timestamp: "invalid" },
		{ ...item, content: { provider: "native" } },
		{ ...item, headers: { authorization: "internal" } },
		{ ...item, submissionId: "not-a-uuid" },
		{ ...item, status: "settled" },
	])("rejects invalid display items: %j", (value) => expect(Check(HistoryItemSchema, value)).toBe(false));
	it.each([
		{ ...result, run: { ...identity, state: "running" } },
		{ ...result, finalItems: [{ ...item, kind: "toolResult" }] },
		{ ...result, finalItems: [{ ...item, runId: null }] },
		{ ...result, finalItems: [{ ...item, rawMessage: {} }] },
		{ ...result, itemIds: [""] },
		{ ...result, handle: {} },
		{ ...result, details: { ...result.details, usage: { completeness: "complete", inputTokens: -1 } } },
		{ ...result, details: { ...result.details, usage: { completeness: "partial", outputTokens: 1.5 } } },
		{ ...result, details: { ...result.details, usage: { completeness: "unknown" } } },
		{ ...result, details: { ...result.details, providerResponse: {} } },
	])("rejects nonterminal or internal result data: %j", (value) =>
		expect(Check(RunResultViewSchema, value)).toBe(false),
	);
});
