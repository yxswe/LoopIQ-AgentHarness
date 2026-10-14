import { type Static, Type } from "typebox";

export const PROTOCOL_VERSION = 1;
export const RPC_ENDPOINTS = { frontend: "/ws/client", runtime: "/ws/runtime" } as const;

const versionFields = { protocolVersion: Type.Literal(PROTOCOL_VERSION) };
const initializeFields = { ...versionFields, token: Type.String({ minLength: 1 }) };
const runtimeId = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });

export const FrontendInitializeParamsSchema = Type.Object(initializeFields, { additionalProperties: false });
export const RuntimeInitializeParamsSchema = Type.Object(
	{ ...initializeFields, runtimeServiceId: runtimeId, runtimeBootId: runtimeId },
	{ additionalProperties: false },
);
/** Identity/version accepted on either endpoint; Runtime readiness is reported separately. */
export const InitializeResultSchema = Type.Object(versionFields, { additionalProperties: false });
export const RuntimeStatusSchema = Type.Object(
	{
		runtimeServiceId: runtimeId,
		state: Type.Union([Type.Literal("offline"), Type.Literal("syncing"), Type.Literal("ready")]),
	},
	{ additionalProperties: false },
);

/** Caller knowledge for one attempt, independent of the Run state and wire error. */
export const DeliveryClassificationSchema = Type.Union([
	Type.Literal("rejected"),
	Type.Literal("uncertain"),
	Type.Literal("confirmed"),
]);

export type DeliveryClassification = Static<typeof DeliveryClassificationSchema>;
export type FrontendInitializeParams = Static<typeof FrontendInitializeParamsSchema>;
export type RuntimeInitializeParams = Static<typeof RuntimeInitializeParamsSchema>;
export type InitializeResult = Static<typeof InitializeResultSchema>;
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;

/** Direction permission only; endpoint owners also enforce schemas, authentication and readiness. */
export const RPC_METHODS = {
	frontendToServer: {
		request: [
			"connection/initialize",
			"runtime/read",
			"session/list",
			"session/read",
			"session/rename",
			"session/create",
			"session/delete",
			"session/delete/read",
			"session/observe",
			"session/ready",
			"session/unobserve",
			"run/start",
			"run/read",
			"run/result",
			"run/steer",
			"run/abort",
		],
		notification: [],
	},
	runtimeToServer: {
		request: ["connection/initialize"],
		notification: ["session/update"],
	},
	serverToRuntime: {
		request: [
			"runtime/inventory",
			"session/create",
			"session/readSnapshot",
			"session/delete",
			"session/delete/read",
			"run/start",
			"run/read",
			"run/result",
			"run/steer",
			"run/abort",
		],
		notification: ["runtime/status"],
	},
	serverToFrontend: {
		request: [],
		notification: ["session/update", "session/observationExpired", "catalog/changed", "runtime/status"],
	},
} as const;

export type RpcDirection = keyof typeof RPC_METHODS;

export function isMethodAllowed(direction: RpcDirection, kind: "request" | "notification", method: string): boolean {
	const methods: readonly string[] = RPC_METHODS[direction][kind];
	return methods.includes(method);
}
