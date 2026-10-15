import { Check } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
	CATALOG_METHOD_SCHEMAS,
	CatalogChangedSchema,
	type CatalogMethodMap,
	isMethodAllowed,
	parseRpcMessage,
	type SessionCatalogEntry,
	SessionCatalogEntrySchema,
	type SessionCatalogView,
	SessionCatalogViewSchema,
} from "./index.ts";

const entry: SessionCatalogEntry = {
	sessionId: "019a0665-dc18-7000-8000-000000000001",
	runtimeServiceId: "019a0665-dc18-7000-8000-000000000002",
	name: "Review tests",
	createdAt: "2026-10-15T12:00:00.000Z",
	updatedAt: "2026-10-15T12:30:00.000Z",
	lifecycle: "ready",
	metadataRevision: 2,
};
const view: SessionCatalogView = {
	catalogRevision: 7,
	session: entry,
	runtime: { runtimeServiceId: entry.runtimeServiceId, state: "offline" },
};
const calls: { [M in keyof CatalogMethodMap]: { method: M } & CatalogMethodMap[M] }[keyof CatalogMethodMap][] = [
	{ method: "runtime/read", params: {}, result: view.runtime },
	{
		method: "session/list",
		params: {},
		result: { catalogRevision: view.catalogRevision, sessions: [entry], runtime: view.runtime },
	},
	{ method: "session/read", params: { sessionId: entry.sessionId }, result: view },
	{ method: "session/rename", params: { sessionId: entry.sessionId, name: " Review tests \n" }, result: view },
];

describe("catalog method contracts", () => {
	it.each(calls)("round-trips frontend-only $method", ({ method, params, result }) => {
		const request = { jsonrpc: "2.0", id: "attempt-1", method, params };
		const reply = { jsonrpc: "2.0", id: request.id, result };
		expect(parseRpcMessage(JSON.stringify(request))).toEqual({ kind: "request", message: request });
		expect(parseRpcMessage(JSON.stringify(reply))).toEqual({ kind: "success", message: reply });
		expect(Check(CATALOG_METHOD_SCHEMAS[method].params, JSON.parse(JSON.stringify(params)))).toBe(true);
		expect(Check(CATALOG_METHOD_SCHEMAS[method].result, JSON.parse(JSON.stringify(result)))).toBe(true);
		expect(isMethodAllowed("frontendToServer", "request", method)).toBe(true);
		for (const direction of ["frontendToServer", "serverToRuntime", "runtimeToServer", "serverToFrontend"] as const) {
			expect(isMethodAllowed(direction, "notification", method)).toBe(false);
			if (direction !== "frontendToServer") expect(isMethodAllowed(direction, "request", method)).toBe(false);
		}
	});
	it.each([
		["runtime/read", { runtimeServiceId: entry.runtimeServiceId }],
		["session/list", { cursor: "unsupported" }],
		["session/list", { includeHistory: true }],
		["session/read", {}],
		["session/read", { sessionId: "not-a-uuid" }],
		["session/read", { sessionId: entry.sessionId, runtimeUrl: "ws://other" }],
		["session/rename", { sessionId: entry.sessionId }],
		["session/rename", { sessionId: entry.sessionId, name: "" }],
		["session/rename", { sessionId: entry.sessionId, name: " \t\n\u00a0" }],
		["session/rename", { sessionId: entry.sessionId, name: "New name", workspaceDir: "/other" }],
	] as const)("rejects invalid %s params: %j", (method, params) => {
		expect(Check(CATALOG_METHOD_SCHEMAS[method].params, params)).toBe(false);
	});
	it("derives shared metadata results and preserves an empty catalog with known availability", () => {
		expectTypeOf<CatalogMethodMap["session/read"]["result"]>().toEqualTypeOf<SessionCatalogView>();
		expectTypeOf<CatalogMethodMap["session/rename"]["result"]>().toEqualTypeOf<SessionCatalogView>();
		expect(
			Check(CATALOG_METHOD_SCHEMAS["session/list"].result, {
				catalogRevision: 0,
				sessions: [],
				runtime: view.runtime,
			}),
		).toBe(true);
	});
});

describe("public catalog metadata", () => {
	it.each(["creating", "ready", "deleting", "missing"])(
		"keeps %s lifecycle separate from link availability",
		(lifecycle) => {
			for (const state of ["offline", "syncing", "ready"]) {
				expect(
					Check(SessionCatalogViewSchema, {
						...view,
						session: { ...entry, lifecycle },
						runtime: { ...view.runtime, state },
					}),
				).toBe(true);
			}
		},
	);
	it.each(["A", "测试 🌍", "a\nb", "Room 1"])("accepts trimmed stored name %j", (name) => {
		expect(Check(SessionCatalogEntrySchema, { ...entry, name })).toBe(true);
	});
	it.each(["", " ", " title", "title ", "title\n", "title\r", "title\u2028", "title\u00a0"])(
		"rejects empty or untrimmed stored name %j",
		(name) => {
			expect(Check(SessionCatalogEntrySchema, { ...entry, name })).toBe(false);
		},
	);
	it.each(["/remote/project", "C:\\projects\\demo"])(
		"preserves Runtime-reported path %j and execution activity",
		(workspaceDir) => {
			const metadata = { ...entry, workspaceDir, lastActivityAt: entry.createdAt };
			expect(Check(SessionCatalogEntrySchema, metadata)).toBe(true);
			expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
		},
	);
	it.each([
		{ runtimeServiceId: "runtime-1" },
		{ workspaceDir: "" },
		{ lifecycle: "archived" },
		{ lifecycle: "running" },
		{ createdAt: "yesterday" },
		{ updatedAt: null },
		{ lastActivityAt: 123 },
		{ metadataRevision: -1 },
		{ metadataRevision: 1.5 },
		{ metadataRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ messages: [] },
		{ token: "secret" },
		{ creationFingerprint: "private" },
		{ operationId: entry.sessionId },
	])("rejects invalid or private entry fields: %j", (fields) => {
		expect(Check(SessionCatalogEntrySchema, { ...entry, ...fields })).toBe(false);
	});
	it.each([
		{ catalogRevision: -1 },
		{ catalogRevision: 0.5 },
		{ catalogRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ runtime: undefined },
		{ runtime: { ...view.runtime, state: "running" } },
		{ runtime: { ...view.runtime, token: "secret" } },
		{ activeRun: {} },
		{ history: [] },
	])("rejects invalid or execution-bearing read results: %j", (fields) => {
		expect(Check(SessionCatalogViewSchema, { ...view, ...fields })).toBe(false);
	});
	it("validates every list entry and excludes extra top-level data", () => {
		const list = { catalogRevision: 7, sessions: [entry], runtime: view.runtime };
		for (const invalid of [
			{ ...list, sessions: [{ ...entry, messages: [] }] },
			{ ...list, history: [] },
		]) {
			expect(Check(CATALOG_METHOD_SCHEMAS["session/list"].result, invalid)).toBe(false);
		}
	});
});

describe("catalog refresh notification", () => {
	it("round-trips a revision-only frontend refresh hint", () => {
		const params = { catalogRevision: 8 };
		const message = { jsonrpc: "2.0", method: "catalog/changed", params };
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "notification", message });
		expect(Check(CatalogChangedSchema, params)).toBe(true);
		for (const direction of ["frontendToServer", "runtimeToServer", "serverToRuntime", "serverToFrontend"] as const) {
			expect(isMethodAllowed(direction, "notification", message.method)).toBe(direction === "serverToFrontend");
			expect(isMethodAllowed(direction, "request", message.method)).toBe(false);
		}
	});
	it.each([{}, { catalogRevision: -1 }, { catalogRevision: 0.5 }, { catalogRevision: 1, sessions: [entry] }])(
		"rejects incomplete or data-bearing hints: %j",
		(params) => expect(Check(CatalogChangedSchema, params)).toBe(false),
	);
});
