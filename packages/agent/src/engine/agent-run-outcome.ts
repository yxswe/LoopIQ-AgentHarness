import type { AssistantMessage } from "@loopiq/ai";
import type { AgentMessage } from "../base/messages.ts";

export type AgentRunOutcome =
	| { status: "completed"; messages: AgentMessage[]; finalMessage: AssistantMessage }
	| { status: "aborted"; messages: AgentMessage[]; finalMessage: AssistantMessage }
	| { status: "failed"; messages: AgentMessage[]; finalMessage?: AssistantMessage; error: Error };
