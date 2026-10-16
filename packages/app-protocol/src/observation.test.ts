import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	RUNTIME_OBSERVATION_METHOD_SCHEMAS as backend,
	type FrontendObservationMethodMap,
	FRONTEND_OBSERVATION_METHOD_SCHEMAS as frontend,
	type HistoryItem,
	isMethodAllowed,
	ObservationExpiredSchema,
	ObservedSessionUpdateSchema,
	parseRpcMessage,
	type RuntimeObservationMethodMap,
	type SessionSnapshot,
	SessionSnapshotSchema,
	type SessionUpdate,
	SessionUpdateSchema,
} from "./index.ts";

const sessionId = "019a0665-dc18-7000-8000-000000000001";
const runId = "019a0665-dc18-7000-8000-000000000002";
const submissionId = "019a0665-dc18-7000-8000-000000000003";
const viewEpoch = "019a0665-dc18-7000-8000-000000000004";
const observationId = "019a0665-dc18-7000-8000-000000000005";
const run = { sessionId, runId, submissionId, state: "running" as const };
const item: HistoryItem = {
	itemId: "assistant-1",
	revision: 1,
	runId,
	kind: "assistantMessage",
	timestamp: "2026-10-16T03:00:00Z",
	status: "inProgress",
	content: "abc",
};
const snapshot: SessionSnapshot = {
	sessionId,
	viewEpoch,
	boundaryRevision: 4,
	currentRun: run,
	runs: [run],
	items: [
		{ ...item, itemId: "legacy-1", kind: "userMessage", runId: null, status: "completed", content: "Old input" },
		{ ...item, itemId: "input-1", kind: "userMessage", submissionId, status: "completed", content: "Request" },
	],
	activeItems: [item],
	uncommittedInputs: [],
};
const delta: SessionUpdate = {
	sessionId,
	viewEpoch,
	viewRevision: 5,
	change: { type: "item/textDelta", itemId: item.itemId, baseRevision: 1, revision: 2, delta: "def" },
};
const changes: SessionUpdate["change"][] = [
	{
		type: "run/state",
		run: { ...run, state: "settled", outcome: { status: "completed" }, completedAt: item.timestamp },
	},
	{ type: "item/upsert", item: { ...item, revision: 3, content: "abcdef", status: "completed" } },
	delta.change,
];
const calls: {
	[M in keyof FrontendObservationMethodMap]: { method: M } & FrontendObservationMethodMap[M];
}[keyof FrontendObservationMethodMap][] = [
	{ method: "session/observe", params: { sessionId }, result: { observationId, snapshot } },
	{ method: "session/ready", params: { observationId, viewEpoch, boundaryRevision: 4 }, result: {} },
	{ method: "session/unobserve", params: { observationId }, result: {} },
];

describe("observation handshake contracts", () => {
	it.each([
		...calls.map((call) => ({ ...call, schema: frontend[call.method], direction: "frontendToServer" as const })),
		{
			method: "session/readSnapshot",
			params: { sessionId },
			result: snapshot,
			schema: backend["session/readSnapshot"],
			direction: "serverToRuntime" as const,
		},
	])("round-trips $direction $method", ({ method, params, result, schema, direction }) => {
		const request = { jsonrpc: "2.0", id: "attempt-1", method, params };
		const reply = { jsonrpc: "2.0", id: request.id, result };
		expect(parseRpcMessage(JSON.stringify(request))).toEqual({ kind: "request", message: request });
		expect(parseRpcMessage(JSON.stringify(reply))).toEqual({ kind: "success", message: reply });
		expect(Check(schema.params, JSON.parse(JSON.stringify(params)))).toBe(true);
		expect(Check(schema.result, JSON.parse(JSON.stringify(result)))).toBe(true);
		for (const peer of ["frontendToServer", "serverToRuntime", "runtimeToServer", "serverToFrontend"] as const) {
			expect(isMethodAllowed(peer, "request", method)).toBe(peer === direction);
			expect(isMethodAllowed(peer, "notification", method)).toBe(false);
		}
	});
	it.each([
		["session/observe", {}],
		["session/observe", { sessionId: "invalid" }],
		["session/observe", { sessionId, cursor: "old-view" }],
		["session/ready", { observationId, viewEpoch }],
		["session/ready", { observationId, viewEpoch: "boot-1", boundaryRevision: 4 }],
		["session/ready", { observationId, viewEpoch, boundaryRevision: -1 }],
		["session/ready", { observationId, viewEpoch, boundaryRevision: 4, sessionId }],
		["session/unobserve", { sessionId }],
		["session/unobserve", { observationId, abort: true }],
	] as const)("rejects invalid %s params: %j", (method, params) => {
		expect(Check(frontend[method].params, params)).toBe(false);
	});
	it("keeps the observation ID out of backend snapshots and derives method types", () => {
		expect(Check(frontend["session/observe"].result, snapshot)).toBe(false);
		expect(Check(backend["session/readSnapshot"].result, { observationId, snapshot })).toBe(false);
		expect(Check(backend["session/readSnapshot"].params, { sessionId, observationId })).toBe(false);
		for (const method of ["session/ready", "session/unobserve"] as const) {
			expect(Check(frontend[method].result, { state: "live" })).toBe(false);
		}
		expectTypeOf<RuntimeObservationMethodMap["session/readSnapshot"]["result"]>().toEqualTypeOf<SessionSnapshot>();
	});
});

describe("captured Session view", () => {
	it("retains legacy attribution, active text and an explicit empty view", () => {
		expect(Check(SessionSnapshotSchema, snapshot)).toBe(true);
		expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
		expect(
			Check(SessionSnapshotSchema, {
				...snapshot,
				boundaryRevision: 0,
				currentRun: null,
				runs: [],
				items: [],
				activeItems: [],
			}),
		).toBe(true);
	});
	it("represents an interrupted acceptance without inventing a committed user item", () => {
		const interrupted = { ...run, state: "settled", outcome: { status: "interrupted" }, completedAt: item.timestamp };
		const recovered = {
			...snapshot,
			currentRun: null,
			runs: [interrupted],
			items: [],
			activeItems: [],
			uncommittedInputs: [{ runId, submissionId, text: " original input 🌍 " }],
		};
		expect(Check(SessionSnapshotSchema, recovered)).toBe(true);
		expect(JSON.parse(JSON.stringify(recovered)).uncommittedInputs[0].text).toBe(" original input 🌍 ");
	});
	it.each([
		{ viewEpoch: "invalid" },
		{ boundaryRevision: -1 },
		{ boundaryRevision: 0.5 },
		{ boundaryRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ currentRun: undefined },
		{ activeItems: undefined },
		{ runs: [{ ...run, state: "settled" }] },
		{ items: [{ ...item, content: { text: "private" } }] },
		{ activeItems: [{ ...item, headers: {} }] },
		{ logBoundary: 100 },
		{ observationId },
		{ uncommittedInputs: [{ runId, submissionId, text: "" }] },
		{ uncommittedInputs: [{ runId, submissionId, text: "input", messages: [] }] },
	])("rejects incomplete or internal snapshot data: %j", (fields) => {
		expect(Check(SessionSnapshotSchema, { ...snapshot, ...fields })).toBe(false);
	});
});

describe("Session update notifications", () => {
	it.each(changes)("round-trips $type on both hops", (change) => {
		const update = { ...delta, change };
		for (const [params, schema, direction] of [
			[update, SessionUpdateSchema, "runtimeToServer"],
			[{ ...update, observationId }, ObservedSessionUpdateSchema, "serverToFrontend"],
		] as const) {
			const message = { jsonrpc: "2.0", method: "session/update", params };
			expect(Check(schema, JSON.parse(JSON.stringify(params)))).toBe(true);
			expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "notification", message });
			expect(isMethodAllowed(direction, "notification", message.method)).toBe(true);
		}
		expect(Check(SessionUpdateSchema, { ...update, observationId })).toBe(false);
		expect(Check(ObservedSessionUpdateSchema, update)).toBe(false);
	});
	it("preserves safe-integer boundaries and verbatim delta text", () => {
		const change = {
			...delta.change,
			baseRevision: Number.MAX_SAFE_INTEGER - 1,
			revision: Number.MAX_SAFE_INTEGER,
			delta: " \n🌍 ",
		};
		const update = { ...delta, viewRevision: Number.MAX_SAFE_INTEGER, change, observationId };
		expect(Check(ObservedSessionUpdateSchema, update)).toBe(true);
		expect(JSON.parse(JSON.stringify(update)).change.delta).toBe(" \n🌍 ");
		expect(Check(ObservedSessionUpdateSchema, { ...update, observationId: "invalid" })).toBe(false);
		expect(Check(ObservedSessionUpdateSchema, { ...update, headers: {} })).toBe(false);
	});
	it.each([
		{ type: "run/state", run: { ...run, headers: {} } },
		{ type: "item/upsert", item, delta: "extra" },
		{ type: "item/textDelta", itemId: item.itemId, revision: 2, delta: "def" },
		{ ...delta.change, baseRevision: -1 },
		{ ...delta.change, revision: 0.5 },
		{ ...delta.change, revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...delta.change, itemId: "" },
		{ ...delta.change, delta: { text: "def" } },
		{ ...delta.change, headers: {} },
		{ type: "thinking/delta", delta: "private" },
	])("rejects malformed, ambiguous or internal changes: %j", (change) => {
		expect(Check(SessionUpdateSchema, { ...delta, change })).toBe(false);
	});
	it.each([
		{ viewRevision: -1 },
		{ viewRevision: 1.5 },
		{ viewRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ viewEpoch: "" },
		{ sessionId: "invalid" },
	])("rejects invalid update identity/revision: %j", (fields) => {
		expect(Check(SessionUpdateSchema, { ...delta, ...fields })).toBe(false);
	});
});

describe("observation expiration", () => {
	it.each(["resyncRequired", "runtimeUnavailable", "sessionDeleted"])("encodes %s without a response", (reason) => {
		const params = { observationId, reason };
		const message = { jsonrpc: "2.0", method: "session/observationExpired", params };
		expect(Check(ObservationExpiredSchema, params)).toBe(true);
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "notification", message });
		for (const direction of ["frontendToServer", "serverToRuntime", "runtimeToServer", "serverToFrontend"] as const) {
			expect(isMethodAllowed(direction, "notification", message.method)).toBe(direction === "serverToFrontend");
			expect(isMethodAllowed(direction, "request", message.method)).toBe(false);
		}
	});
	it.each([
		{},
		{ observationId },
		{ observationId: "invalid", reason: "resyncRequired" },
		{ observationId, reason: "timeout" },
		{ observationId, reason: "sessionDeleted", history: [] },
	])("rejects incomplete or data-bearing expiration: %j", (params) =>
		expect(Check(ObservationExpiredSchema, params)).toBe(false),
	);
});
