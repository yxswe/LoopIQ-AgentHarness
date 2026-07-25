import { describe, expect, it } from "vitest";
import { AgentEventBus } from "./event-bus.ts";

describe("AgentEventBus hook reducers", () => {
	it("chains context and before-agent transformations", async () => {
		const bus = new AgentEventBus();
		bus.on("context", (event) => ({
			messages: [...event.messages, { role: "user", content: "second", timestamp: 2 }],
		}));
		bus.on("context", (event) => ({
			messages: [...event.messages, { role: "user", content: "third", timestamp: 3 }],
		}));
		bus.on("before_agent_start", () => ({
			messages: [{ role: "user", content: "injected-a", timestamp: 4 }],
			systemPrompt: "prompt-a",
		}));
		bus.on("before_agent_start", (event) => ({
			messages: [{ role: "user", content: event.systemPrompt, timestamp: 5 }],
			systemPrompt: "prompt-b",
		}));

		const context = await bus.emitHook({
			type: "context",
			messages: [{ role: "user", content: "first", timestamp: 1 }],
		});
		expect(context?.messages).toHaveLength(3);

		const before = await bus.emitHook({
			type: "before_agent_start",
			prompt: "hello",
			systemPrompt: "initial",
			resources: {},
		});
		expect(before?.systemPrompt).toBe("prompt-b");
		expect(before?.messages).toHaveLength(2);
		expect(before?.messages?.[1]).toMatchObject({ content: "prompt-a" });
	});

	it("chains provider patches with deletion and stops tool calls on the first block", async () => {
		const bus = new AgentEventBus();
		bus.on("before_provider_request", () => ({
			streamOptions: { headers: { remove: undefined, added: "yes" } },
		}));
		bus.on("before_provider_request", (event) => ({
			streamOptions: { timeoutMs: event.streamOptions.headers?.added === "yes" ? 42 : 0 },
		}));
		let laterToolHandlerCalled = false;
		bus.on("tool_call", () => ({ block: true, reason: "blocked" }));
		bus.on("tool_call", () => {
			laterToolHandlerCalled = true;
			return undefined;
		});

		const provider = await bus.emitHook({
			type: "before_provider_request",
			model: {} as never,
			sessionId: "session",
			streamOptions: { headers: { remove: "value", keep: "value" } },
		});
		expect(provider?.streamOptions).toEqual({ headers: { keep: "value", added: "yes" }, timeoutMs: 42 });

		const tool = await bus.emitHook({
			type: "tool_call",
			toolCallId: "call",
			toolName: "tool",
			input: {},
		});
		expect(tool).toEqual({ block: true, reason: "blocked" });
		expect(laterToolHandlerCalled).toBe(false);
	});
});
