import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

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
	| { kind: "invalid"; code: -32700 | -32600 };

/** Classify bounded JSON text; endpoint owners validate method-specific payloads. */
export function parseRpcMessage(text: string): ParsedRpcMessage {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { kind: "invalid", code: -32700 };
	}

	if (Check(RpcRequestSchema, value)) return { kind: "request", message: value };
	if (Check(RpcNotificationSchema, value)) return { kind: "notification", message: value };
	if (Check(RpcSuccessSchema, value)) return { kind: "success", message: value };
	if (Check(RpcFailureSchema, value)) return { kind: "failure", message: value };
	return { kind: "invalid", code: -32600 };
}
