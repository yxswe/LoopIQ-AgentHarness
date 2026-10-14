import { type Static, Type } from "typebox";
import { HistoryItemSchema } from "./history.ts";

const uuid = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });
const text = Type.String({ minLength: 1 });
const tokenCount = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const RunRefSchema = Type.Object({ sessionId: uuid, runId: uuid }, { additionalProperties: false });
export const RunIdentitySchema = Type.Object(
	{ ...RunRefSchema.properties, submissionId: uuid },
	{ additionalProperties: false },
);
export const RunOutcomeSchema = Type.Union([
	Type.Object({ status: Type.Enum(["completed", "aborted", "interrupted"]) }, { additionalProperties: false }),
	Type.Object(
		{
			status: Type.Literal("failed"),
			error: Type.Object({ code: text, message: Type.String() }, { additionalProperties: false }),
		},
		{ additionalProperties: false },
	),
]);
export const SettledRunViewSchema = Type.Object(
	{
		...RunIdentitySchema.properties,
		state: Type.Literal("settled"),
		outcome: RunOutcomeSchema,
		completedAt: Type.String({ format: "date-time" }),
	},
	{ additionalProperties: false },
);
export const RunViewSchema = Type.Union([
	Type.Object(
		{ ...RunIdentitySchema.properties, state: Type.Enum(["accepted", "running", "settling"]) },
		{ additionalProperties: false },
	),
	SettledRunViewSchema,
]);
export const RunLookupSchema = Type.Union([
	Type.Object({ kind: Type.Literal("known"), run: RunViewSchema }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("notAccepted") }, { additionalProperties: false }),
	Type.Object(
		{ kind: Type.Literal("unknown"), reason: Type.Enum(["recordsUnavailable", "legacyHistory"]) },
		{ additionalProperties: false },
	),
]);
export const ResultDetailsSchema = Type.Object(
	{
		terminationReason: Type.Enum(["stop", "outputLimit", "abort", "error", "unknown"]),
		usage: Type.Object(
			{
				completeness: Type.Enum(["complete", "partial", "unavailable"]),
				inputTokens: Type.Optional(tokenCount),
				outputTokens: Type.Optional(tokenCount),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
export const RunResultViewSchema = Type.Object(
	{
		run: SettledRunViewSchema,
		finalItems: Type.Array(
			Type.Object(
				{ ...HistoryItemSchema.properties, kind: Type.Literal("assistantMessage"), runId: uuid },
				{ additionalProperties: false },
			),
		),
		itemIds: Type.Array(Type.String({ minLength: 1 })),
		details: ResultDetailsSchema,
	},
	{ additionalProperties: false },
);

/** Shared by frontend -> server and server -> Runtime; direction/admission checks remain separate. */
export const RUN_METHOD_SCHEMAS = {
	"run/start": {
		params: Type.Object({ sessionId: uuid, submissionId: uuid, text }, { additionalProperties: false }),
		result: RunIdentitySchema,
	},
	"run/read": {
		params: Type.Union([
			RunRefSchema,
			Type.Object({ sessionId: uuid, submissionId: uuid }, { additionalProperties: false }),
		]),
		result: RunLookupSchema,
	},
	"run/result": { params: RunRefSchema, result: RunResultViewSchema },
	"run/steer": {
		params: Type.Object(
			{ ...RunRefSchema.properties, text, interruptCurrentInference: Type.Optional(Type.Boolean()) },
			{ additionalProperties: false },
		),
		result: Type.Object({}, { additionalProperties: false }),
	},
	"run/abort": { params: RunRefSchema, result: SettledRunViewSchema },
} as const;

export type RunRef = Static<typeof RunRefSchema>;
export type RunIdentity = Static<typeof RunIdentitySchema>;
export type RunOutcome = Static<typeof RunOutcomeSchema>;
export type SettledRunView = Static<typeof SettledRunViewSchema>;
export type RunView = Static<typeof RunViewSchema>;
export type RunLookup = Static<typeof RunLookupSchema>;
export type ResultDetails = Static<typeof ResultDetailsSchema>;
export type RunResultView = Static<typeof RunResultViewSchema>;
export type RunMethodMap = {
	[Method in keyof typeof RUN_METHOD_SCHEMAS]: {
		params: Static<(typeof RUN_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof RUN_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
