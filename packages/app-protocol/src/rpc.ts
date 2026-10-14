import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isWithinUtf8Limit, PROTOCOL_LIMITS } from "./limits.ts";

export const RPC_ERROR_CODES = {
	parseError: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	business: -32000,
} as const;

export const BusinessErrorReasonSchema = Type.Union([
	Type.Literal("NOT_INITIALIZED"),
	Type.Literal("UNAUTHORIZED"),
	Type.Literal("VERSION_UNSUPPORTED"),
	Type.Literal("RUNTIME_ALREADY_CONNECTED"),
	Type.Literal("RUNTIME_OFFLINE"),
	Type.Literal("RUNTIME_SYNCING"),
	Type.Literal("SESSION_BUSY"),
	Type.Literal("CAPACITY_EXCEEDED"),
	Type.Literal("STALE_RUN"),
	Type.Literal("RUN_NOT_SETTLED"),
	Type.Literal("SUBMISSION_CONFLICT"),
	Type.Literal("CREATION_CONFLICT"),
	Type.Literal("CONFIGURATION_INVALID"),
	Type.Literal("SESSION_NOT_FOUND"),
	Type.Literal("SESSION_DELETED"),
	Type.Literal("WORKSPACE_INVALID"),
	Type.Literal("SESSION_LOCKED"),
	Type.Literal("STORAGE_UNAVAILABLE"),
	Type.Literal("RECOVERY_REQUIRED"),
	Type.Literal("SNAPSHOT_TOO_LARGE"),
	Type.Literal("INPUT_TOO_LARGE"),
	Type.Literal("OBSERVATION_EXPIRED"),
	Type.Literal("INTERACTION_UNSUPPORTED"),
]);

export const RpcErrorSchema = Type.Union([
	Type.Object(
		{
			code: Type.Union([
				Type.Literal(RPC_ERROR_CODES.parseError),
				Type.Literal(RPC_ERROR_CODES.invalidRequest),
				Type.Literal(RPC_ERROR_CODES.methodNotFound),
				Type.Literal(RPC_ERROR_CODES.invalidParams),
			]),
			message: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			code: Type.Literal(RPC_ERROR_CODES.business),
			message: Type.String(),
			data: Type.Object({ reason: BusinessErrorReasonSchema }, { additionalProperties: false }),
		},
		{ additionalProperties: false },
	),
]);

export type BusinessErrorReason = Static<typeof BusinessErrorReasonSchema>;
export type RpcError = Static<typeof RpcErrorSchema>;

const rpcId = Type.String({ minLength: 1 });
const callFields = {
	jsonrpc: Type.Literal("2.0"),
	method: Type.String({ minLength: 1 }),
	params: Type.Record(Type.String(), Type.Unknown()),
};

export const RpcRequestSchema = Type.Object({ ...callFields, id: rpcId }, { additionalProperties: false });
export const RpcNotificationSchema = Type.Object(callFields, { additionalProperties: false });
export const RpcSuccessSchema = Type.Object(
	{ jsonrpc: Type.Literal("2.0"), id: rpcId, result: Type.Unknown() },
	{ additionalProperties: false },
);
export const RpcFailureSchema = Type.Object(
	{
		jsonrpc: Type.Literal("2.0"),
		id: Type.Union([rpcId, Type.Null()]),
		error: Type.Object(
			{ code: Type.Integer(), message: Type.String(), data: Type.Optional(Type.Unknown()) },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type RpcRequest = Static<typeof RpcRequestSchema>;
export type RpcNotification = Static<typeof RpcNotificationSchema>;
export type RpcSuccess = Static<typeof RpcSuccessSchema>;
export type RpcFailure = Static<typeof RpcFailureSchema>;

export type ParsedRpcMessage =
	| { kind: "request"; message: RpcRequest }
	| { kind: "notification"; message: RpcNotification }
	| { kind: "success"; message: RpcSuccess }
	| { kind: "failure"; message: RpcFailure }
	| { kind: "tooLarge" }
	| { kind: "invalid"; code: -32700 | -32600 };

/** Bound and classify JSON text; endpoint owners validate payloads, including error data. */
export function parseRpcMessage(text: string): ParsedRpcMessage {
	if (!isWithinUtf8Limit(text, PROTOCOL_LIMITS.jsonMessageBytes)) return { kind: "tooLarge" };
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "invalid", code: RPC_ERROR_CODES.parseError };
	}

	if (Check(RpcRequestSchema, value)) return { kind: "request", message: value };
	if (Check(RpcNotificationSchema, value)) return { kind: "notification", message: value };
	if (Check(RpcSuccessSchema, value)) return { kind: "success", message: value };
	if (Check(RpcFailureSchema, value)) return { kind: "failure", message: value };
	return { kind: "invalid", code: RPC_ERROR_CODES.invalidRequest };
}
