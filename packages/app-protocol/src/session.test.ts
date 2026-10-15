import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	RUNTIME_SESSION_METHOD_SCHEMAS as backend,
	type FrontendSessionMethodMap,
	FRONTEND_SESSION_METHOD_SCHEMAS as frontend,
	isMethodAllowed,
	parseRpcMessage,
	type RuntimeInventory,
	RuntimeInventorySchema,
	RuntimeSessionEntrySchema,
	type RuntimeSessionMethodMap,
	type SessionCreation,
	SessionCreationEvidenceSchema,
	SessionDeletionLookupSchema,
} from "./index.ts";

const sessionId = "019a0665-dc18-7000-8000-000000000001";
const operationId = "019a0665-dc18-7000-8000-000000000002";
const runtimeServiceId = "019a0665-dc18-7000-8000-000000000003";
const timestamp = "2026-10-15T12:00:00Z";
const created: SessionCreation = {
	sessionId,
	workspaceDir: "/remote/project",
	createdAt: timestamp,
	settings: { model: { providerId: "openai", modelId: "test-model" }, thinkingLevel: "high" },
};
const publicCreated: FrontendSessionMethodMap["session/create"]["result"] = {
	catalogRevision: 2,
	session: {
		sessionId,
		workspaceDir: created.workspaceDir,
		createdAt: timestamp,
		updatedAt: timestamp,
		runtimeServiceId,
		name: "Review",
		metadataRevision: 1,
		lifecycle: "ready",
	},
	runtime: { runtimeServiceId, state: "ready" },
	settings: created.settings,
};
const ref = { sessionId, operationId };
const deleting = { ...ref, state: "deleting" as const, startedAt: timestamp };
const deleted = { ...ref, state: "deleted" as const, startedAt: timestamp, completedAt: timestamp };
const entry: RuntimeInventory["sessions"][number] = {
	sessionId,
	workspaceDir: created.workspaceDir,
	createdAt: timestamp,
	execution: "available",
	creation: { kind: "recorded", params: {}, settings: created.settings },
};
const inventory: RuntimeInventory = {
	complete: true,
	sessions: [entry],
	deletions: [{ ...deleted, sessionId: operationId }],
};
const frontendCalls: {
	[M in keyof FrontendSessionMethodMap]: { method: M } & FrontendSessionMethodMap[M];
}[keyof FrontendSessionMethodMap][] = [
	{ method: "session/create", params: { sessionId, name: " Review " }, result: publicCreated },
	{ method: "session/delete", params: ref, result: { ...deleted, catalogRevision: 3 } },
	{ method: "session/delete/read", params: ref, result: deleting },
];
const backendCalls: {
	[M in keyof RuntimeSessionMethodMap]: { method: M } & RuntimeSessionMethodMap[M];
}[keyof RuntimeSessionMethodMap][] = [
	{ method: "runtime/inventory", params: {}, result: inventory },
	{ method: "session/create", params: { sessionId }, result: created },
	{ method: "session/delete", params: ref, result: deleted },
	{ method: "session/delete/read", params: ref, result: { ...ref, state: "notStarted" } },
];

describe("Session lifecycle method contracts", () => {
	it.each([
		...frontendCalls.map((call) => ({
			...call,
			schema: frontend[call.method],
			direction: "frontendToServer" as const,
		})),
		...backendCalls.map((call) => ({ ...call, schema: backend[call.method], direction: "serverToRuntime" as const })),
	])("round-trips $direction $method", ({ method, params, result, schema, direction }) => {
		const request = { jsonrpc: "2.0", id: "attempt-1", method, params };
		const reply = { jsonrpc: "2.0", id: request.id, result };
		expect(parseRpcMessage(JSON.stringify(request))).toEqual({ kind: "request", message: request });
		expect(parseRpcMessage(JSON.stringify(reply))).toEqual({ kind: "success", message: reply });
		expect(Check(schema.params, JSON.parse(JSON.stringify(params)))).toBe(true);
		expect(Check(schema.result, JSON.parse(JSON.stringify(result)))).toBe(true);
		expect(isMethodAllowed(direction, "request", method)).toBe(true);
		for (const peer of ["frontendToServer", "serverToRuntime", "runtimeToServer", "serverToFrontend"] as const) {
			expect(isMethodAllowed(peer, "notification", method)).toBe(false);
			if (peer === "runtimeToServer" || peer === "serverToFrontend")
				expect(isMethodAllowed(peer, "request", method)).toBe(false);
		}
	});
	it("separates endpoint payloads and derives results from their schemas", () => {
		expect(Check(backend["session/create"].params, frontendCalls[0]!.params)).toBe(false);
		expect(Check(backend["session/create"].result, publicCreated)).toBe(false);
		expect(Check(frontend["session/create"].result, created)).toBe(false);
		expect(Check(frontend["session/create"].result, { ...publicCreated, creation: entry.creation })).toBe(false);
		expect(
			Check(frontend["session/create"].result, {
				...publicCreated,
				session: { ...publicCreated.session, workspaceDir: undefined },
			}),
		).toBe(false);
		expect(Check(frontend["session/delete"].result, deleted)).toBe(false);
		expect(Check(backend["session/delete"].result, { ...deleted, catalogRevision: 3 })).toBe(false);
		expect(isMethodAllowed("frontendToServer", "request", "runtime/inventory")).toBe(false);
		expectTypeOf<RuntimeSessionMethodMap["session/create"]["result"]>().toEqualTypeOf<SessionCreation>();
	});
	it.each([
		{},
		{ sessionId: "invalid" },
		{ sessionId, workspaceDir: "" },
		{ sessionId, model: created.settings.model },
		{ sessionId, token: "secret" },
		{ sessionId, runtimeServiceId },
		{ sessionId, thinkingLevel: "low" },
	])("rejects invalid or configuration-bearing creation params: %j", (params) => {
		for (const schemas of [frontend, backend]) expect(Check(schemas["session/create"].params, params)).toBe(false);
	});
	it.each(["", " \t\n"])("rejects blank creation name %j", (name) => {
		expect(Check(frontend["session/create"].params, { sessionId, name })).toBe(false);
	});
	it.each([{}, { workspaceDir: "/remote/project" }, { workspaceDir: "C:\\projects\\demo" }])(
		"preserves supplied cwd independently of resolved cwd: %j",
		(params) => {
			expect(Check(backend["session/create"].params, { sessionId, ...params })).toBe(true);
			const evidence = { kind: "recorded", params, settings: created.settings };
			expect(Check(SessionCreationEvidenceSchema, evidence)).toBe(true);
			expect(JSON.parse(JSON.stringify(evidence)).params).toEqual(params);
		},
	);
	it.each(["creating", "deleting", "missing"])("rejects %s as creation success", (lifecycle) => {
		expect(
			Check(frontend["session/create"].result, {
				...publicCreated,
				session: { ...publicCreated.session, lifecycle },
			}),
		).toBe(false);
	});
	it.each([
		{ workspaceDir: undefined },
		{ workspaceDir: "" },
		{ createdAt: "yesterday" },
		{ settings: undefined },
		{ settings: { ...created.settings, token: "secret" } },
		{ settings: { ...created.settings, model: { ...created.settings.model, headers: {} } } },
		{ settings: { ...created.settings, thinkingLevel: "ultra" } },
	])("rejects incomplete or unsafe creation results: %j", (fields) => {
		expect(Check(backend["session/create"].result, { ...created, ...fields })).toBe(false);
	});
});

describe("authoritative deletion evidence", () => {
	it.each([{ ...ref, state: "notStarted" }, deleting, deleted])("distinguishes $state from completion", (lookup) => {
		expect(Check(SessionDeletionLookupSchema, lookup)).toBe(true);
		expect(Check(backend["session/delete"].result, lookup)).toBe(lookup.state === "deleted");
		expect(Check(frontend["session/delete"].result, { ...lookup, catalogRevision: 3 })).toBe(
			lookup.state === "deleted",
		);
		expect(Check(RuntimeInventorySchema, { complete: true, sessions: [], deletions: [lookup] })).toBe(
			lookup.state !== "notStarted",
		);
	});
	it.each([{}, { sessionId }, { ...ref, operationId: "invalid" }, { ...ref, force: true }])(
		"requires exact deletion identities: %j",
		(params) => {
			for (const schemas of [frontend, backend])
				for (const method of ["session/delete", "session/delete/read"] as const) {
					expect(Check(schemas[method].params, params)).toBe(false);
				}
		},
	);
	it.each([
		{ ...ref, state: "unknown" },
		{ ...ref, state: "notStarted", startedAt: timestamp },
		{ ...deleting, completedAt: timestamp },
		{ ...deleted, completedAt: undefined },
		{ ...deleted, startedAt: "yesterday" },
		{ ...deleted, messages: [] },
	])("rejects ambiguous or unsafe lookup: %j", (lookup) => {
		expect(Check(SessionDeletionLookupSchema, lookup)).toBe(false);
	});
});

describe("Runtime inventory boundary", () => {
	it.each(["available", "busy", "locked", "recoveryRequired"])(
		"encodes %s discovery without a creation receipt",
		(execution) => {
			expect(Check(RuntimeSessionEntrySchema, { ...entry, execution, creation: { kind: "unrecorded" } })).toBe(true);
		},
	);
	it("permits an authoritative empty scan, never a partial success or paginated request", () => {
		expect(Check(RuntimeInventorySchema, { complete: true, sessions: [], deletions: [] })).toBe(true);
		for (const value of [
			{ ...inventory, complete: false },
			{ ...inventory, complete: undefined },
			{ ...inventory, deletions: undefined },
			{ ...inventory, cursor: "more" },
		])
			expect(Check(RuntimeInventorySchema, value)).toBe(false);
		expect(Check(backend["runtime/inventory"].params, { cursor: "more" })).toBe(false);
	});
	it.each([
		{ kind: "recorded", params: {} },
		{ kind: "recorded", params: { name: "Private" }, settings: created.settings },
		{ kind: "unrecorded", params: {} },
		{ kind: "unrecorded", settings: created.settings },
	])("rejects incomplete or fabricated creation evidence: %j", (creation) => {
		expect(Check(RuntimeInventorySchema, { ...inventory, sessions: [{ ...entry, creation }] })).toBe(false);
	});
	it.each([
		{ name: "Server-owned" },
		{ history: [] },
		{ token: "secret" },
		{ execution: "ready" },
		{ creation: undefined },
		{ lastActivityAt: "yesterday" },
	])("rejects invalid or foreign inventory data: %j", (fields) => {
		expect(Check(RuntimeInventorySchema, { ...inventory, sessions: [{ ...entry, ...fields }] })).toBe(false);
	});
});
