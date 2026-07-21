import type { AgentHookEvent, AgentHookEventResultMap, AgentNotificationEvent } from "../base/events.ts";
import type { PromptTemplate, Skill } from "../base/resource.ts";
import { normalizeHookError } from "../base/types.ts";
import { applyStreamOptionsPatch, cloneStreamOptions } from "./stream-options.ts";

const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: any, signal?: AbortSignal) => Promise<any> | any;

/**
 * Registration and dispatch of harness events.
 *
 * Two channels share one handler map, keyed by event type:
 * - `subscribe()` registers read-only listeners under {@link SUBSCRIBER_EVENT_TYPE};
 *   {@link emit} broadcasts {@link AgentNotificationEvent}s to them and ignores return values.
 * - `on(type)` registers interceptable hooks under a concrete type; {@link emitHook}
 *   dispatches to them and returns the last non-undefined result.
 */
export class AgentEventBus<TSkill extends Skill = Skill, TPromptTemplate extends PromptTemplate = PromptTemplate> {
	private handlers = new Map<string, Set<AgentHarnessHandler>>();

	private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
		return this.handlers.get(type);
	}

	subscribe(
		listener: (event: AgentNotificationEvent<TSkill, TPromptTemplate>, signal?: AbortSignal) => Promise<void> | void,
	): () => void {
		let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
		}
		handlers.add(listener as AgentHarnessHandler);
		return () => handlers!.delete(listener as AgentHarnessHandler);
	}

	on<TType extends keyof AgentHookEventResultMap>(
		type: TType,
		handler: (
			event: Extract<AgentHookEvent, { type: TType }>,
		) => Promise<AgentHookEventResultMap[TType]> | AgentHookEventResultMap[TType],
	): () => void {
		let handlers = this.handlers.get(type);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(type, handlers);
		}
		handlers.add(handler as AgentHarnessHandler);
		return () => handlers!.delete(handler as AgentHarnessHandler);
	}

	async emit(event: AgentNotificationEvent<TSkill, TPromptTemplate>, signal?: AbortSignal): Promise<void> {
		for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
			try {
				await listener(event, signal);
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
	}

	async emitHook<TType extends keyof AgentHookEventResultMap>(
		event: Extract<AgentHookEvent, { type: TType }>,
	): Promise<AgentHookEventResultMap[TType] | undefined> {
		const handlers = this.getHandlers(event.type as TType);
		if (!handlers || handlers.size === 0) return undefined;
		// The public generic signature is fully typed. This local cast is needed
		// because TypeScript cannot narrow an Extract union through a generic key.
		const hookEvent = event as AgentHookEvent & Record<string, any>;
		try {
			switch (hookEvent.type) {
				case "context": {
					let messages = hookEvent.messages;
					for (const handler of handlers) {
						const result = await handler({ ...hookEvent, messages });
						if (result?.messages) messages = result.messages;
					}
					return (messages === hookEvent.messages ? undefined : { messages }) as AgentHookEventResultMap[TType];
				}
				case "before_agent_start": {
					let systemPrompt = hookEvent.systemPrompt;
					const messages = [];
					for (const handler of handlers) {
						const result = await handler({ ...hookEvent, systemPrompt });
						if (result?.messages) messages.push(...result.messages);
						if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
					}
					return (
						messages.length > 0 || systemPrompt !== hookEvent.systemPrompt
							? { messages, systemPrompt }
							: undefined
					) as AgentHookEventResultMap[TType];
				}
				case "before_provider_request": {
					let streamOptions = cloneStreamOptions(hookEvent.streamOptions);
					let changed = false;
					for (const handler of handlers) {
						const result = await handler({ ...hookEvent, streamOptions: cloneStreamOptions(streamOptions) });
						if (result?.streamOptions) {
							streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
							changed = true;
						}
					}
					return (changed ? { streamOptions } : undefined) as AgentHookEventResultMap[TType];
				}
				case "before_provider_payload": {
					let payload = hookEvent.payload;
					let changed = false;
					for (const handler of handlers) {
						const result = await handler({ ...hookEvent, payload });
						if (result !== undefined) {
							payload = result.payload;
							changed = true;
						}
					}
					return (changed ? { payload } : undefined) as AgentHookEventResultMap[TType];
				}
				case "tool_call": {
					for (const handler of handlers) {
						const result = await handler(hookEvent);
						if (result?.block) return result;
					}
					return undefined;
				}
				case "tool_result": {
					let current = hookEvent;
					let changed = false;
					for (const handler of handlers) {
						const result = await handler(current);
						if (!result) continue;
						current = {
							...current,
							content: result.content ?? current.content,
							details: result.details ?? current.details,
							isError: result.isError ?? current.isError,
							terminate: result.terminate ?? current.terminate,
						};
						changed = true;
					}
					return (
						changed
							? {
									content: current.content,
									details: current.details,
									isError: current.isError,
									terminate: current.terminate,
								}
							: undefined
					) as AgentHookEventResultMap[TType];
				}
				case "session_before_compact": {
					let lastResult: AgentHookEventResultMap[TType] | undefined;
					for (const handler of handlers) {
						const result = await handler(hookEvent);
						if (result !== undefined) lastResult = result;
						if (result?.cancel) return result;
					}
					return lastResult;
				}
			}
		} catch (error) {
			throw normalizeHookError(error);
		}
	}
}
