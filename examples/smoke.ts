import { registerFauxProvider, fauxAssistantMessage } from "@loopiq/ai/compat";
import { Agent } from "@loopiq/agent-core";

async function main(): Promise<void> {
	// 注册一个离线 faux provider，并预置一条回复
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("Hello from the faux model! 2 + 2 = 4.")]);
	const model = faux.getModel();

	const agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful assistant. Keep responses concise.",
			model,
			thinkingLevel: "off",
			tools: [],
		},
	});

	// 流式打印助手输出
	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			process.stdout.write(event.assistantMessageEvent.delta);
		}
	});

	await agent.prompt("What is 2 + 2?");
	process.stdout.write("\n");

	const last = agent.state.messages[agent.state.messages.length - 1];
	if (last.role !== "assistant") {
		throw new Error(`Expected assistant message, got ${last.role}`);
	}
	const text = last.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("");
	if (!text.includes("4")) {
		throw new Error(`Smoke assertion failed: reply did not contain "4": ${text}`);
	}

	faux.unregister();
	console.log("[smoke] OK");
}

main().catch((error) => {
	console.error("[smoke] FAILED:", error);
	process.exit(1);
});
