import { type Static, Type } from "typebox";
import { CatalogChangedSchema, SessionCatalogEntrySchema, SessionCatalogViewSchema } from "./catalog.ts";

const uuid = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });
const timestamp = Type.String({ format: "date-time" });
const text = Type.String({ minLength: 1 });
const creationInput = Type.Object({ workspaceDir: Type.Optional(text) }, { additionalProperties: false });
const sessionMetadata = { sessionId: uuid, workspaceDir: text, createdAt: timestamp };
const deletionRef = Type.Object({ sessionId: uuid, operationId: uuid }, { additionalProperties: false });

/** Initial resolved settings, without provider objects, credentials or request policy. */
export const SessionSettingsSchema = Type.Object(
	{
		model: Type.Object({ providerId: text, modelId: text }, { additionalProperties: false }),
		thinkingLevel: Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh"]),
	},
	{ additionalProperties: false },
);
export const SessionCreationSchema = Type.Object(
	{ ...sessionMetadata, settings: SessionSettingsSchema },
	{ additionalProperties: false },
);

/** Recorded input retains omission of cwd; resolved cwd and creation time are on the entry. */
export const SessionCreationEvidenceSchema = Type.Union([
	Type.Object(
		{ kind: Type.Literal("recorded"), params: creationInput, settings: SessionSettingsSchema },
		{ additionalProperties: false },
	),
	Type.Object({ kind: Type.Literal("unrecorded") }, { additionalProperties: false }),
]);
export const SessionDeletionCompleteSchema = Type.Object(
	{
		...deletionRef.properties,
		state: Type.Literal("deleted"),
		startedAt: timestamp,
		completedAt: timestamp,
	},
	{ additionalProperties: false },
);
export const SessionDeletionRecordSchema = Type.Union([
	Type.Object(
		{ ...deletionRef.properties, state: Type.Literal("deleting"), startedAt: timestamp },
		{ additionalProperties: false },
	),
	SessionDeletionCompleteSchema,
]);
export const SessionDeletionLookupSchema = Type.Union([
	Type.Object({ ...deletionRef.properties, state: Type.Literal("notStarted") }, { additionalProperties: false }),
	SessionDeletionRecordSchema,
]);

export const RuntimeSessionEntrySchema = Type.Object(
	{
		...sessionMetadata,
		lastActivityAt: Type.Optional(timestamp),
		execution: Type.Enum(["available", "busy", "locked", "recoveryRequired"]),
		creation: SessionCreationEvidenceSchema,
	},
	{ additionalProperties: false },
);
/** Only complete scans are successful results; partial/unreadable inventory is an RPC error. */
export const RuntimeInventorySchema = Type.Object(
	{
		complete: Type.Literal(true),
		sessions: Type.Array(RuntimeSessionEntrySchema),
		deletions: Type.Array(SessionDeletionRecordSchema),
	},
	{ additionalProperties: false },
);

export const RUNTIME_SESSION_METHOD_SCHEMAS = {
	"runtime/inventory": {
		params: Type.Object({}, { additionalProperties: false }),
		result: RuntimeInventorySchema,
	},
	"session/create": {
		params: Type.Object({ sessionId: uuid, ...creationInput.properties }, { additionalProperties: false }),
		result: SessionCreationSchema,
	},
	"session/delete": { params: deletionRef, result: SessionDeletionCompleteSchema },
	"session/delete/read": { params: deletionRef, result: SessionDeletionLookupSchema },
} as const;

export const FRONTEND_SESSION_METHOD_SCHEMAS = {
	"session/create": {
		params: Type.Object(
			{
				...RUNTIME_SESSION_METHOD_SCHEMAS["session/create"].params.properties,
				name: Type.Optional(Type.String({ pattern: "\\S" })),
			},
			{ additionalProperties: false },
		),
		result: Type.Object(
			{
				...SessionCatalogViewSchema.properties,
				session: Type.Object(
					{ ...SessionCatalogEntrySchema.properties, workspaceDir: text, lifecycle: Type.Literal("ready") },
					{ additionalProperties: false },
				),
				settings: SessionSettingsSchema,
			},
			{ additionalProperties: false },
		),
	},
	"session/delete": {
		params: deletionRef,
		result: Type.Object(
			{ ...SessionDeletionCompleteSchema.properties, ...CatalogChangedSchema.properties },
			{ additionalProperties: false },
		),
	},
	"session/delete/read": { params: deletionRef, result: SessionDeletionLookupSchema },
} as const;

export type SessionSettings = Static<typeof SessionSettingsSchema>;
export type SessionCreation = Static<typeof SessionCreationSchema>;
export type SessionCreationEvidence = Static<typeof SessionCreationEvidenceSchema>;
export type SessionDeletionComplete = Static<typeof SessionDeletionCompleteSchema>;
export type SessionDeletionRecord = Static<typeof SessionDeletionRecordSchema>;
export type SessionDeletionLookup = Static<typeof SessionDeletionLookupSchema>;
export type RuntimeSessionEntry = Static<typeof RuntimeSessionEntrySchema>;
export type RuntimeInventory = Static<typeof RuntimeInventorySchema>;
export type RuntimeSessionMethodMap = {
	[Method in keyof typeof RUNTIME_SESSION_METHOD_SCHEMAS]: {
		params: Static<(typeof RUNTIME_SESSION_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof RUNTIME_SESSION_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
export type FrontendSessionMethodMap = {
	[Method in keyof typeof FRONTEND_SESSION_METHOD_SCHEMAS]: {
		params: Static<(typeof FRONTEND_SESSION_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof FRONTEND_SESSION_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
