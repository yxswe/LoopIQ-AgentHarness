import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type ToolResultMessage,
	type UserMessage,
} from "@loopiq/ai";
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../base/messages.ts";
import { type AgentContext, DEFAULT_PROVIDER_REQUEST_POLICY } from "../base/options.ts";
import { CONTEXT_SUMMARY_PREFIX, CONTEXT_SUMMARY_SUFFIX } from "./compaction-prompt.ts";
import { ContextManager } from "./context-manager.ts";

function user(content: string, timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

function assistant(content: string, timestamp: number): AgentMessage {
	return { ...fauxAssistantMessage(content, { timestamp }), usage: { ...fauxAssistantMessage("").usage } };
}

function createFixture(contextWindow = 1_000, maxTokens = 100) {
	const faux = fauxProvider({
		provider: `context-faux-${Math.random()}`,
		models: [{ id: "context-model", contextWindow, maxTokens }],
	});
	const models = createModels();
	models.setProvider(faux.provider);
	return { faux, model: faux.getModel(), manager: new ContextManager(models) };
}

function context(messages: AgentMessage[]): AgentContext {
	return { systemPrompt: "", messages, tools: [] };
}

describe("ContextManager", () => {
	it("triggers at 90% and chooses a complete recent instruction boundary when possible", () => {
		const { manager, model } = createFixture();
		expect(manager.prepare(context([user("small", 1)]), model)).toBeUndefined();

		const prepared = manager.prepare(
			context([user("u".repeat(1_800), 1), assistant("a".repeat(1_800), 2), user("recent".repeat(34), 3)]),
			model,
		);

		expect(prepared).toMatchObject({
			compactedMessageCount: 2,
			splitInstructionSpan: false,
			triggerTokens: 900,
			targetTokens: 500,
		});
		expect(prepared?.retainedMessages).toEqual([expect.objectContaining({ role: "user", timestamp: 3 })]);
	});

	it("uses an assistant boundary to bridge an unusually large instruction span", () => {
		const { manager, model } = createFixture();
		const prepared = manager.prepare(
			context([
				user("instruction".repeat(200), 1),
				assistant("work".repeat(360), 2),
				assistant("recent".repeat(35), 3),
			]),
			model,
		);

		expect(prepared).toMatchObject({ compactedMessageCount: 2, splitInstructionSpan: true });
		expect(prepared?.messagesToSummarize).toEqual([]);
		expect(prepared?.instructionPrefixMessages.map((message) => message.timestamp)).toEqual([1, 2]);
		expect(prepared?.retainedMessages.map((message) => message.timestamp)).toEqual([3]);
	});

	it("keeps tool calls and their results on the same side of a cut", () => {
		const { manager, model } = createFixture();
		const toolCall = {
			...assistant("", 2),
			content: [fauxToolCall("Read", { path: "large.txt" }, { id: "call-1" })],
		} as AgentMessage;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "Read",
			content: [{ type: "text", text: "r".repeat(2_000) }],
			isError: false,
			timestamp: 3,
		};
		const prepared = manager.prepare(
			context([user("history".repeat(230), 1), toolCall, toolResult, user("current".repeat(20), 4)]),
			model,
		);

		expect(prepared?.compactedMessageCount).toBe(3);
		expect(prepared?.messagesToSummarize.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(prepared?.retainedMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("retains a trailing tool continuation as the protected suffix", () => {
		const { manager, model } = createFixture();
		const toolCall = {
			...assistant("", 2),
			content: [fauxToolCall("Read", { path: "file.txt" }, { id: "call-2" })],
		} as AgentMessage;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "Read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 3,
		};
		const prepared = manager.prepare(context([user("old".repeat(1_200), 1), toolCall, toolResult]), model);

		expect(prepared?.compactedMessageCount).toBe(1);
		expect(prepared?.retainedMessages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
	});

	it("allows missing tool results that provider message normalization can repair", () => {
		const { manager, model } = createFixture();
		const toolCall = {
			...assistant("", 2),
			content: [
				{ type: "text" as const, text: "work".repeat(400) },
				fauxToolCall("Read", { path: "missing.txt" }, { id: "missing-result" }),
			],
		} as AgentMessage;

		const prepared = manager.prepare(context([user("old".repeat(1_200), 1), toolCall, user("current", 3)]), model);

		expect(prepared?.messagesToSummarize.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(prepared?.retainedMessages.map((message) => message.role)).toEqual(["user"]);
	});

	it("allows an aborted assistant with an incomplete tool call to be compacted", () => {
		const { manager, model } = createFixture();
		const abortedToolCall = {
			...assistant("", 2),
			content: [
				{ type: "text" as const, text: "partial".repeat(250) },
				fauxToolCall("Read", { path: "partial.txt" }, { id: "aborted-call" }),
			],
			stopReason: "aborted" as const,
		} as AgentMessage;

		const prepared = manager.prepare(
			context([user("old".repeat(1_200), 1), abortedToolCall, user("retry", 3)]),
			model,
		);

		expect(prepared?.messagesToSummarize.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(prepared?.retainedMessages).toEqual([expect.objectContaining({ role: "user", timestamp: 3 })]);
	});

	it("updates an existing summary from only the newly compacted raw messages", async () => {
		const { faux, manager, model } = createFixture();
		let summaryPrompt = "";
		faux.setResponses([
			(request) => {
				summaryPrompt = String(request.messages[0]?.content);
				return fauxAssistantMessage("updated facts");
			},
		]);
		const previous = user(`${CONTEXT_SUMMARY_PREFIX}previous facts${CONTEXT_SUMMARY_SUFFIX}`, 10);
		const source = context([
			previous,
			user("new".repeat(800), 11),
			assistant("work".repeat(400), 12),
			user("current", 13),
		]);
		const prepared = manager.prepare(source, model);

		expect(prepared?.previousSummary).toBe("previous facts");
		expect(prepared?.messagesToSummarize.map((message) => message.timestamp)).toEqual([11, 12]);
		expect(prepared?.compactedMessageCount).toBe(3);
		await manager.compact(prepared!, {
			sessionId: "repeated-compaction",
			model,
			providerRequestPolicy: DEFAULT_PROVIDER_REQUEST_POLICY,
			systemPrompt: source.systemPrompt,
			tools: [],
			signal: new AbortController().signal,
		});
		expect(summaryPrompt).toContain("<previous-summary>\nprevious facts\n</previous-summary>");
		expect(summaryPrompt).toContain("<conversation>\n[User]: newnew");
		expect(summaryPrompt.indexOf("<conversation>")).toBeLessThan(summaryPrompt.indexOf("<previous-summary>"));
	});

	it("summarizes without tools or reasoning and truncates large tool results deterministically", async () => {
		const { faux, model, manager } = createFixture(2_000, 100);
		let summaryPrompt = "";
		let summaryOptions: Record<string, unknown> | undefined;
		faux.setResponses([
			(request, options) => {
				summaryPrompt = String(request.messages[0]?.content);
				summaryOptions = options as Record<string, unknown>;
				expect(request.tools).toBeUndefined();
				return fauxAssistantMessage("concise summary");
			},
		]);
		const toolCall = {
			...assistant("", 2),
			content: [fauxToolCall("Read", {}, { id: "large-call" })],
		} as AgentMessage;
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "large-call",
			toolName: "Read",
			content: [{ type: "text", text: "x".repeat(4_000) }],
			isError: false,
			timestamp: 3,
		};
		const source = context([user("history".repeat(500), 1), toolCall, toolResult, user("current", 4)]);
		const prepared = manager.prepare(source, model)!;
		const result = await manager.compact(prepared, {
			sessionId: "context-session",
			model: model as Model<any>,
			providerRequestPolicy: DEFAULT_PROVIDER_REQUEST_POLICY,
			systemPrompt: source.systemPrompt,
			tools: [],
			signal: new AbortController().signal,
		});

		expect(summaryPrompt).toContain("characters truncated");
		expect(summaryPrompt).not.toContain("x".repeat(3_000));
		expect(summaryOptions).toMatchObject({ maxTokens: 100 });
		expect(summaryOptions).not.toHaveProperty("reasoning");
		expect(result.messages[0]).toEqual(result.summary);
		expect(result.afterTokens).toBeLessThan(result.triggerTokens);
	});

	it("classifies a thrown summary request error as summarization failure", async () => {
		const { faux, model, manager } = createFixture();
		faux.setResponses([
			async () => {
				throw new Error("summary provider failed");
			},
		]);
		const source = context([user("u".repeat(1_800), 1), assistant("a".repeat(1_800), 2), user("current", 3)]);
		const prepared = manager.prepare(source, model)!;

		await expect(
			manager.compact(prepared, {
				sessionId: "failed-summary",
				model,
				providerRequestPolicy: DEFAULT_PROVIDER_REQUEST_POLICY,
				systemPrompt: source.systemPrompt,
				tools: [],
				signal: new AbortController().signal,
			}),
		).rejects.toMatchObject({ code: "summarization_failed", message: "summary provider failed" });
	});
});
