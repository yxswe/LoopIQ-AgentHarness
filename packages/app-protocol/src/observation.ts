import { type Static, Type } from "typebox";
import { HistoryItemSchema } from "./history.ts";
import { RunViewSchema } from "./run.ts";

const uuid = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const viewFields = { sessionId: uuid, viewEpoch: uuid };
const observationRef = Type.Object({ observationId: uuid }, { additionalProperties: false });

/** One captured view; the durable log boundary stays inside Runtime. */
export const SessionSnapshotSchema = Type.Object(
	{
		...viewFields,
		boundaryRevision: revision,
		currentRun: Type.Union([RunViewSchema, Type.Null()]),
		runs: Type.Array(RunViewSchema),
		items: Type.Array(HistoryItemSchema),
		activeItems: Type.Array(HistoryItemSchema),
		uncommittedInputs: Type.Array(
			Type.Object(
				{ runId: uuid, submissionId: uuid, text: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** Runtime -> app-server update; each frontend observer gets its own wrapper identity. */
export const SessionUpdateSchema = Type.Object(
	{
		...viewFields,
		viewRevision: revision,
		change: Type.Union([
			Type.Object({ type: Type.Literal("run/state"), run: RunViewSchema }, { additionalProperties: false }),
			Type.Object({ type: Type.Literal("item/upsert"), item: HistoryItemSchema }, { additionalProperties: false }),
			Type.Object(
				{
					type: Type.Literal("item/textDelta"),
					itemId: Type.String({ minLength: 1 }),
					baseRevision: revision,
					revision,
					delta: Type.String(),
				},
				{ additionalProperties: false },
			),
		]),
	},
	{ additionalProperties: false },
);
export const ObservedSessionUpdateSchema = Type.Object(
	{ ...SessionUpdateSchema.properties, ...observationRef.properties },
	{ additionalProperties: false },
);
export const ObservationExpiredSchema = Type.Object(
	{
		...observationRef.properties,
		reason: Type.Enum(["resyncRequired", "runtimeUnavailable", "sessionDeleted"]),
	},
	{ additionalProperties: false },
);

export const RUNTIME_OBSERVATION_METHOD_SCHEMAS = {
	"session/readSnapshot": {
		params: Type.Object({ sessionId: uuid }, { additionalProperties: false }),
		result: SessionSnapshotSchema,
	},
} as const;
export const FRONTEND_OBSERVATION_METHOD_SCHEMAS = {
	"session/observe": {
		params: Type.Object({ sessionId: uuid }, { additionalProperties: false }),
		result: Type.Object(
			{ ...observationRef.properties, snapshot: SessionSnapshotSchema },
			{ additionalProperties: false },
		),
	},
	"session/ready": {
		params: Type.Object(
			{ ...observationRef.properties, viewEpoch: uuid, boundaryRevision: revision },
			{ additionalProperties: false },
		),
		result: Type.Object({}, { additionalProperties: false }),
	},
	"session/unobserve": {
		params: observationRef,
		result: Type.Object({}, { additionalProperties: false }),
	},
} as const;

export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionUpdate = Static<typeof SessionUpdateSchema>;
export type ObservedSessionUpdate = Static<typeof ObservedSessionUpdateSchema>;
export type ObservationExpired = Static<typeof ObservationExpiredSchema>;
export type RuntimeObservationMethodMap = {
	[Method in keyof typeof RUNTIME_OBSERVATION_METHOD_SCHEMAS]: {
		params: Static<(typeof RUNTIME_OBSERVATION_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof RUNTIME_OBSERVATION_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
export type FrontendObservationMethodMap = {
	[Method in keyof typeof FRONTEND_OBSERVATION_METHOD_SCHEMAS]: {
		params: Static<(typeof FRONTEND_OBSERVATION_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof FRONTEND_OBSERVATION_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
