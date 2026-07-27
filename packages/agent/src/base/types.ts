/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

export type SessionErrorCode = "not_found" | "invalid_session" | "invalid_entry" | "storage";

/** Error thrown by session storage and session operations. */
export class SessionError extends Error {
	/** Session subsystem error code. */
	public code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export type AgentRuntimeErrorCode =
	| "busy"
	| "invalid_state"
	| "invalid_argument"
	| "provider_not_found"
	| "model_not_found"
	| "provider_auth_required"
	| "provider_credential_invalid"
	| "provider_validation_unavailable"
	| "provider_credential_canceled"
	| "provider_credential_setup_failed"
	| "provider_busy"
	| "credential_store"
	| "agent_configuration"
	| "session"
	| "session_locked"
	| "unknown";

/** Public agent runtime failure with a stable top-level classification. */
export class AgentRuntimeError extends Error {
	public code: AgentRuntimeErrorCode;

	constructor(code: AgentRuntimeErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentRuntimeError";
		this.code = code;
	}
}

/** Wrap an unknown thrown value into an {@link AgentRuntimeError}, preserving subsystem codes. */
export function normalizeRuntimeError(error: unknown, fallbackCode: AgentRuntimeErrorCode): AgentRuntimeError {
	if (error instanceof AgentRuntimeError) return error;
	const cause = toError(error);
	if (cause instanceof SessionError) return new AgentRuntimeError("session", cause.message, cause);
	return new AgentRuntimeError(fallbackCode, cause.message, cause);
}
