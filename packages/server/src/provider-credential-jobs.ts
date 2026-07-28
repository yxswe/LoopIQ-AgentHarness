import { randomUUID } from "node:crypto";
import type { Agent, ProviderAuthEvent, ProviderAuthMethod, ProviderAuthPrompt, ProviderStatus } from "@loopiq/agent";

export type ProviderCredentialJobEvent =
	| { type: "auth_event"; event: ProviderAuthEvent }
	| { type: "prompt"; promptId: string; prompt: Omit<ProviderAuthPrompt, "signal"> }
	| { type: "completed"; status: ProviderStatus }
	| { type: "failed"; error: string; code?: string }
	| { type: "canceled" };

interface PendingPrompt {
	id: string;
	resolve(value: string): void;
	reject(error: Error): void;
	cleanup(): void;
}

interface CredentialJob {
	id: string;
	controller: AbortController;
	events: ProviderCredentialJobEvent[];
	listeners: Set<(event: ProviderCredentialJobEvent) => void>;
	pendingPrompt?: PendingPrompt;
	settled: boolean;
}

export class ProviderCredentialJobs {
	private readonly jobs = new Map<string, CredentialJob>();
	private readonly settledRetentionMs: number;

	constructor(options?: { settledRetentionMs?: number }) {
		this.settledRetentionMs = options?.settledRetentionMs ?? 5 * 60_000;
	}

	start(agent: Agent, providerId: string, method: ProviderAuthMethod): string {
		const job: CredentialJob = {
			id: randomUUID(),
			controller: new AbortController(),
			events: [],
			listeners: new Set(),
			settled: false,
		};
		this.jobs.set(job.id, job);
		void agent
			.addProviderCredential(providerId, {
				method,
				interaction: {
					signal: job.controller.signal,
					notify: (event) => this.publish(job, { type: "auth_event", event }),
					prompt: (prompt) => this.prompt(job, prompt),
				},
			})
			.then((status) => {
				this.settle(job, { type: "completed", status });
			})
			.catch((error) => {
				if (job.controller.signal.aborted) this.settle(job, { type: "canceled" });
				else {
					this.settle(job, {
						type: "failed",
						error: error instanceof Error ? error.message : String(error),
						code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
					});
				}
			});
		return job.id;
	}

	has(jobId: string): boolean {
		return this.jobs.has(jobId);
	}

	respond(jobId: string, promptId: string, value: string): boolean {
		const job = this.jobs.get(jobId);
		if (!job?.pendingPrompt || job.pendingPrompt.id !== promptId) return false;
		const pending = job.pendingPrompt;
		job.pendingPrompt = undefined;
		pending.cleanup();
		pending.resolve(value);
		return true;
	}

	cancel(jobId: string): boolean {
		const job = this.jobs.get(jobId);
		if (!job || job.settled) return false;
		job.controller.abort();
		job.pendingPrompt?.cleanup();
		job.pendingPrompt?.reject(new Error("Credential job canceled"));
		job.pendingPrompt = undefined;
		return true;
	}

	subscribe(jobId: string, listener: (event: ProviderCredentialJobEvent) => void): (() => void) | undefined {
		const job = this.jobs.get(jobId);
		if (!job) return undefined;
		for (const event of job.events) listener(event);
		if (!job.settled) job.listeners.add(listener);
		return () => job.listeners.delete(listener);
	}

	private prompt(job: CredentialJob, prompt: ProviderAuthPrompt): Promise<string> {
		if (job.pendingPrompt) return Promise.reject(new Error("Credential job already has a pending prompt"));
		return new Promise<string>((resolve, reject) => {
			const promptId = randomUUID();
			const { signal: promptSignal, ...serializedPrompt } = prompt;
			const cleanup = () => {
				promptSignal?.removeEventListener("abort", abort);
				job.controller.signal.removeEventListener("abort", abort);
			};
			const abort = () => {
				if (job.pendingPrompt?.id !== promptId) return;
				job.pendingPrompt = undefined;
				cleanup();
				reject(new Error("Credential prompt canceled"));
			};
			job.pendingPrompt = { id: promptId, resolve, reject, cleanup };
			promptSignal?.addEventListener("abort", abort, { once: true });
			job.controller.signal.addEventListener("abort", abort, { once: true });
			if (promptSignal?.aborted || job.controller.signal.aborted) {
				abort();
				return;
			}
			this.publish(job, { type: "prompt", promptId, prompt: serializedPrompt });
		});
	}

	private publish(job: CredentialJob, event: ProviderCredentialJobEvent): void {
		job.events.push(event);
		for (const listener of job.listeners) {
			try {
				listener(event);
			} catch {
				job.listeners.delete(listener);
			}
		}
	}

	private settle(job: CredentialJob, event: ProviderCredentialJobEvent): void {
		if (job.settled) return;
		job.settled = true;
		job.pendingPrompt?.cleanup();
		job.pendingPrompt = undefined;
		this.publish(job, event);
		job.listeners.clear();
		const timer = setTimeout(() => {
			if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
		}, this.settledRetentionMs);
		timer.unref?.();
	}
}
