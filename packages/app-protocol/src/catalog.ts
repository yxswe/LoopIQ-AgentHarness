import { type Static, Type } from "typebox";
import { RuntimeStatusSchema } from "./connection.ts";

const uuid = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });
const timestamp = Type.String({ format: "date-time" });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Require a fully trimmed stored name, including after a final line terminator.
const storedName = Type.String({ pattern: "^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])" });

/** Persisted public metadata; private operation evidence and execution history stay separate. */
export const SessionCatalogEntrySchema = Type.Object(
	{
		sessionId: uuid,
		runtimeServiceId: uuid,
		name: storedName,
		workspaceDir: Type.Optional(Type.String({ minLength: 1 })),
		createdAt: timestamp,
		updatedAt: timestamp,
		lastActivityAt: Type.Optional(timestamp),
		lifecycle: Type.Enum(["creating", "ready", "deleting", "missing"]),
		metadataRevision: revision,
	},
	{ additionalProperties: false },
);

/** A refresh hint for the committed catalog, never a Session observation or transcript. */
export const CatalogChangedSchema = Type.Object({ catalogRevision: revision }, { additionalProperties: false });
export const SessionCatalogViewSchema = Type.Object(
	{
		...CatalogChangedSchema.properties,
		session: SessionCatalogEntrySchema,
		runtime: RuntimeStatusSchema,
	},
	{ additionalProperties: false },
);

/** App-server-owned operations; none is forwarded as a Runtime Session command. */
export const CATALOG_METHOD_SCHEMAS = {
	"runtime/read": {
		params: Type.Object({}, { additionalProperties: false }),
		result: RuntimeStatusSchema,
	},
	"session/list": {
		params: Type.Object({}, { additionalProperties: false }),
		result: Type.Object(
			{
				...CatalogChangedSchema.properties,
				sessions: Type.Array(SessionCatalogEntrySchema),
				runtime: RuntimeStatusSchema,
			},
			{ additionalProperties: false },
		),
	},
	"session/read": {
		params: Type.Object({ sessionId: uuid }, { additionalProperties: false }),
		result: SessionCatalogViewSchema,
	},
	"session/rename": {
		params: Type.Object({ sessionId: uuid, name: Type.String({ pattern: "\\S" }) }, { additionalProperties: false }),
		result: SessionCatalogViewSchema,
	},
} as const;

export type SessionCatalogEntry = Static<typeof SessionCatalogEntrySchema>;
export type CatalogChanged = Static<typeof CatalogChangedSchema>;
export type SessionCatalogView = Static<typeof SessionCatalogViewSchema>;
export type CatalogMethodMap = {
	[Method in keyof typeof CATALOG_METHOD_SCHEMAS]: {
		params: Static<(typeof CATALOG_METHOD_SCHEMAS)[Method]["params"]>;
		result: Static<(typeof CATALOG_METHOD_SCHEMAS)[Method]["result"]>;
	};
};
