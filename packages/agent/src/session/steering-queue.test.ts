import type { UserMessage } from "@loopiq/ai";
import { describe, expect, it } from "vitest";
import { SteeringQueue } from "./steering-queue.ts";

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("AgentSession SteeringQueue", () => {
	it("drains one message at a time and clears the remainder", async () => {
		const queue = new SteeringQueue();
		queue.enqueue(userMessage("first"));
		queue.enqueue(userMessage("second"));

		expect(await queue.drainOne(async () => undefined)).toMatchObject([{ content: "first" }]);
		expect(queue.clear()).toMatchObject([{ content: "second" }]);
		expect(queue.snapshot()).toEqual([]);
	});

	it("restores a drained message when notification fails", async () => {
		const queue = new SteeringQueue();
		queue.enqueue(userMessage("retry"));

		await expect(
			queue.drainOne(async () => {
				throw new Error("listener failed");
			}),
		).rejects.toThrow("listener failed");
		expect(queue.snapshot()).toMatchObject([{ content: "retry" }]);
	});
});
