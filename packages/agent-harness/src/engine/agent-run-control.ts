import { AgentHarnessError } from "../base/types.ts";

export type InferenceInterruptReason = "steer";

export interface InferenceScope {
	readonly signal: AbortSignal;
	getInterruptReason(): InferenceInterruptReason | undefined;
	close(): void;
}

export interface AgentRunControlView {
	readonly runSignal: AbortSignal;
	openInferenceScope(): InferenceScope;
}

export interface AgentRunController extends AgentRunControlView {
	abortRun(): void;
	interruptInference(reason: InferenceInterruptReason): boolean;
	dispose(): void;
}

export function createAgentRunController(): AgentRunController {
	const runController = new AbortController();
	let activeScope:
		| {
				controller: AbortController;
				reason?: InferenceInterruptReason;
		  }
		| undefined;
	let disposed = false;

	return {
		get runSignal() {
			return runController.signal;
		},

		openInferenceScope(): InferenceScope {
			if (disposed) throw new AgentHarnessError("invalid_state", "AgentRun control is disposed");
			if (activeScope) throw new AgentHarnessError("invalid_state", "An inference scope is already active");

			const scope = { controller: new AbortController(), reason: undefined as InferenceInterruptReason | undefined };
			activeScope = scope;
			const abortFromRun = () => scope.controller.abort(runController.signal.reason);
			if (runController.signal.aborted) abortFromRun();
			else runController.signal.addEventListener("abort", abortFromRun, { once: true });

			return {
				signal: scope.controller.signal,
				getInterruptReason: () => scope.reason,
				close: () => {
					runController.signal.removeEventListener("abort", abortFromRun);
					if (activeScope === scope) activeScope = undefined;
				},
			};
		},

		abortRun(): void {
			runController.abort(new Error("AgentRun aborted"));
		},

		interruptInference(reason: InferenceInterruptReason): boolean {
			if (!activeScope || activeScope.controller.signal.aborted || runController.signal.aborted) return false;
			activeScope.reason = reason;
			activeScope.controller.abort(new Error(`Agent inference interrupted: ${reason}`));
			return true;
		},

		dispose(): void {
			disposed = true;
			activeScope?.controller.abort(new Error("AgentRun control disposed"));
			activeScope = undefined;
		},
	};
}
