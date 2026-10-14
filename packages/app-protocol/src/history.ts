import { type Static, Type } from "typebox";

const uuid = Type.String({ format: "uuid", minLength: 36, maxLength: 36 });

/** Display text shared by retained results and observation; never provider-native messages. */
export const HistoryItemSchema = Type.Object(
	{
		itemId: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		runId: Type.Union([uuid, Type.Null()]),
		submissionId: Type.Optional(uuid),
		kind: Type.Enum(["userMessage", "assistantMessage", "toolCall", "toolResult"]),
		toolCallId: Type.Optional(Type.String({ minLength: 1 })),
		timestamp: Type.String({ format: "date-time" }),
		status: Type.Optional(Type.Enum(["inProgress", "completed", "failed", "interrupted"])),
		content: Type.String(),
	},
	{ additionalProperties: false },
);

export type HistoryItem = Static<typeof HistoryItemSchema>;
