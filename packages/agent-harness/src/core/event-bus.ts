import type { Model } from "@loopiq/ai";

import type {
	AgentHookEvent,
	AgentHookEventResultMap,
	AgentNotificationEvent,
} from "../base/events.ts";
import type { PromptTemplate, Skill } from "../base/resource.ts";
import { normalizeHookError } from "../base/types.ts";

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
export class AgentEventBus<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	private handlers = new Map<string, Set<AgentHarnessHandler>>();

	getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
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
		let lastResult: AgentHookEventResultMap[TType] | undefined;
		for (const handler of handlers) {
			try {
				const result = await handler(event);
				if (result !== undefined) {
					lastResult = result;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return lastResult;
	}

	async emitBeforeProviderPayload(model: Model<any>, payload: unknown): Promise<unknown> {
		const handlers = this.getHandlers("before_provider_payload");
		let current = payload;
		if (!handlers || handlers.size === 0) return current;
		for (const handler of handlers) {
			try {
				const result = await handler({ type: "before_provider_payload", model, payload: current });
				if (result !== undefined) {
					current = result.payload;
				}
			} catch (error) {
				throw normalizeHookError(error);
			}
		}
		return current;
	}
}
