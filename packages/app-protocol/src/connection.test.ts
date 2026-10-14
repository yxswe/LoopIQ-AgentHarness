import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	DeliveryClassificationSchema,
	FrontendInitializeParamsSchema,
	InitializeResultSchema,
	isMethodAllowed,
	PROTOCOL_VERSION,
	parseRpcMessage,
	RPC_ENDPOINTS,
	RPC_METHODS,
	type RpcDirection,
	RuntimeInitializeParamsSchema,
	RuntimeStatusSchema,
} from "./index.ts";

const frontend = { protocolVersion: 1, token: "fixture-frontend-token" };
const runtime = {
	protocolVersion: 1,
	token: "fixture-runtime-token",
	runtimeServiceId: "019a0665-dc18-7000-8000-000000000001",
	runtimeBootId: "019a0665-dc18-7000-8000-000000000002",
};
const directions = Object.keys(RPC_METHODS) as RpcDirection[];

describe("connection initialization", () => {
	it("fixes the version and endpoint paths", () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(RPC_ENDPOINTS).toEqual({ frontend: "/ws/client", runtime: "/ws/runtime" });
	});

	it.each([
		["frontend", FrontendInitializeParamsSchema, frontend],
		["runtime", RuntimeInitializeParamsSchema, runtime],
	])("round-trips %s initialization and its correlated response", (_, schema, params) => {
		const request = { jsonrpc: "2.0", id: "init-1", method: "connection/initialize", params };
		expect(parseRpcMessage(JSON.stringify(request))).toEqual({ kind: "request", message: request });
		expect(Check(schema, params)).toBe(true);
		const reply = { jsonrpc: "2.0", id: "init-1", result: { protocolVersion: 1 } };
		expect(parseRpcMessage(JSON.stringify(reply))).toEqual({ kind: "success", message: reply });
		expect(Check(InitializeResultSchema, reply.result)).toBe(true);
	});

	it("rejects initialization for the other endpoint and role promotion", () => {
		expect(Check(RuntimeInitializeParamsSchema, frontend)).toBe(false);
		expect(Check(FrontendInitializeParamsSchema, runtime)).toBe(false);
		expect(Check(FrontendInitializeParamsSchema, { ...frontend, role: "runtime" })).toBe(false);
	});

	it.each([
		{ protocolVersion: "1" },
		{ protocolVersion: 2 },
		{ protocolVersion: undefined },
		{ token: "" },
		{ token: undefined },
		{ token: 123 },
		{ headers: { authorization: "internal" } },
	])("rejects malformed or unsupported initialization fields: %j", (fields) => {
		expect(Check(FrontendInitializeParamsSchema, { ...frontend, ...fields })).toBe(false);
		expect(Check(RuntimeInitializeParamsSchema, { ...runtime, ...fields })).toBe(false);
	});

	it.each(["runtimeServiceId", "runtimeBootId"] as const)("requires a bare UUID for %s", (field) => {
		for (const value of [undefined, "", "runtime-1", `urn:uuid:${runtime[field]}`, `${runtime[field]}\n`]) {
			expect(Check(RuntimeInitializeParamsSchema, { ...runtime, [field]: value })).toBe(false);
		}
	});

	it("does not encode Runtime readiness in the initialization response", () => {
		for (const result of [{}, { protocolVersion: 2 }, { protocolVersion: 1, state: "ready" }]) {
			expect(Check(InitializeResultSchema, result)).toBe(false);
		}
	});

	it.each(["offline", "syncing", "ready"])("round-trips separate Runtime status: %s", (state) => {
		const params = { runtimeServiceId: runtime.runtimeServiceId, state };
		const message = { jsonrpc: "2.0", method: "runtime/status", params };
		expect(parseRpcMessage(JSON.stringify(message))).toEqual({ kind: "notification", message });
		expect(Check(RuntimeStatusSchema, params)).toBe(true);
	});

	it.each([
		{ state: "running" },
		{ state: "ready" },
		{ runtimeServiceId: runtime.runtimeServiceId, state: "authenticated" },
		{ runtimeServiceId: runtime.runtimeServiceId, state: "ready", token: runtime.token },
	])("rejects invalid or internal Runtime status fields: %j", (status) => {
		expect(Check(RuntimeStatusSchema, status)).toBe(false);
	});
});

describe("caller delivery knowledge", () => {
	it.each([
		["timeout after forwarding", "uncertain"],
		["disconnect after forwarding", "uncertain"],
		["authoritative SESSION_BUSY rejection", "rejected"],
		["durable acceptance response", "confirmed"],
	])("encodes %s independently of Run state", (_, classification) => {
		expect(Check(DeliveryClassificationSchema, JSON.parse(JSON.stringify(classification)))).toBe(true);
	});

	it.each(["failed", "aborted", "accepted", "settled", "timeout", "SESSION_BUSY"])(
		"excludes Run outcomes, causes and error reasons: %s",
		(classification) => expect(Check(DeliveryClassificationSchema, classification)).toBe(false),
	);
});

describe("RPC method directions", () => {
	it.each([
		["connection/initialize", ["frontendToServer", "runtimeToServer"]],
		["runtime/inventory", ["serverToRuntime"]],
		["session/readSnapshot", ["serverToRuntime"]],
		["session/rename", ["frontendToServer"]],
		["session/observe", ["frontendToServer"]],
		["session/ready", ["frontendToServer"]],
		["run/start", ["frontendToServer", "serverToRuntime"]],
		["run/abort", ["frontendToServer", "serverToRuntime"]],
		["session/update", []],
		["runtime/status", []],
	])("permits %s requests only in their declared directions", (method, allowed) => {
		for (const direction of directions) {
			expect(isMethodAllowed(direction, "request", method)).toBe(allowed.includes(direction));
		}
	});

	it.each([
		["session/update", ["runtimeToServer", "serverToFrontend"]],
		["runtime/status", ["serverToRuntime", "serverToFrontend"]],
		["catalog/changed", ["serverToFrontend"]],
		["session/observationExpired", ["serverToFrontend"]],
		["connection/initialize", []],
		["run/start", []],
	])("permits %s notifications only for their recipients", (method, allowed) => {
		for (const direction of directions) {
			expect(isMethodAllowed(direction, "notification", method)).toBe(allowed.includes(direction));
		}
	});

	it.each(["connection/initialized", "ping", "future/method", "toString", "__proto__"])(
		"rejects undeclared method %s in both message kinds",
		(method) => {
			for (const direction of directions) {
				expect(isMethodAllowed(direction, "request", method)).toBe(false);
				expect(isMethodAllowed(direction, "notification", method)).toBe(false);
			}
		},
	);
});
