# Agent Runtime Lifecycle

Status: Implemented behavior

Last audited: 2026-07-25

This document defines the public `Agent` lifecycle and its internal split
between `AgentEngine`, `AgentRun`, `AgentSession`, and `NodeSessionHost`. The
detailed run algorithm is documented in [`agent-run.md`](./agent-run.md), and
multi-Session ownership is documented in
[`multi-session-runtime.md`](./multi-session-runtime.md).

## Ownership

- `Agent` is the application composition root. Adapters call its identity-based
  methods and never receive a concrete host, engine, or Session.
- `ModelRuntime` owns the supported provider registry, model catalog, persisted
  credentials, online validation state, and shared streaming capability.
- `AgentEngine` is an internal Session-stateless capability created by
  `createAgentEngine({ models })`. It retains no current Session or run.
- Each `engine.run()` call creates one short-lived `AgentRun` containing mutable
  provider/tool-loop state for that request.
- `AgentSession` owns one durable Session's storage, writer, environment, tools,
  configuration, queues, hooks, event sequence, and active-run control.
- Internal `NodeSessionHost` owns discovery, single-flight open, writer leases,
  create/open/list/close/delete/shutdown, and per-Session tool construction.

One `AgentSession` admits one structural run at a time. Different Sessions can
call the same engine concurrently.

## Run Reservation and Identity

`Agent.run(sessionId, input)` first resolves the internal Session and preflights
its persisted provider credential. Missing credentials fail with
`provider_auth_required`; expired OAuth credentials are refreshed and persisted
through the credential-store lock. Before preflight, the Agent acquires an
in-process provider-use guard that excludes explicit credential replacement and
removal. The guard creates no run ID and is released on preflight failure or
after the accepted run settles. Authentication failure creates no run ID.

After preflight, the call to
`AgentSession.startRun(input)` is synchronous: it validates input, creates a
unique `runId` and `AgentRunController`, changes the Session from `idle` to
`running`, publishes the current handle, and only then starts asynchronous
snapshot construction. The Agent method is asynchronous because Session open
and authentication preflight may require I/O.

This prevents two callers from passing an asynchronous idle check. The returned
handle contains the durable `sessionId`, unique `runId`, and a result promise.

Public steer and abort commands always carry both identities:

```ts
const handle = await agent.run(sessionId, input);
await agent.steer(sessionId, handle.runId, nextInput, options);
await agent.abort(sessionId, handle.runId);
```

Both commands compare the supplied `runId` with the Session's current handle. A
delayed command from a settled run is rejected with
`AgentRuntimeError("invalid_state")`; it is never redirected to a newer run.

## Turn Snapshots

`AgentSession` constructs `TurnState` snapshots from:

- persisted Session context;
- current model and thinking level;
- copied stream options and resources;
- current active tools;
- the system-prompt string or provider callback;
- the durable Session ID used for provider affinity.

The engine receives the initial snapshot in `AgentRunInput`. At every successful
turn save point it asks the run-bound port for a fresh snapshot. Configuration
changes therefore affect a later provider request without mutating an in-flight
request.

System-prompt providers do not yet accept an `AbortSignal`. A run aborted during
snapshot creation completes that callback, then enters the engine with an
already-aborted signal.

## Port Boundary

`AgentRun` cannot access `Session`, `SessionWriter`, `MessageQueues`, or
`AgentEventBus` directly. Its `AgentRunPort` provides only:

- next-turn, steering, and follow-up drains;
- complete-message commit;
- pending-write inspection and flush;
- next-snapshot construction;
- notification and hook dispatch.

The port closure is bound to one `(sessionId, runId)` pair and validates the
current run before every Session mutation or callback. Concurrent engine calls
therefore cannot select Session state through shared mutable engine fields.

## Persistence and Event Ordering

The implemented ordering is:

1. `message_start` and assistant `message_update` are emitted as progress.
2. A complete user, assistant, or tool-result message is appended to Session.
3. Only after append succeeds is `message_end` emitted.
4. `turn_end` listeners are awaited while their error is captured.
5. Pending writes are flushed even when a `turn_end` listener failed.
6. A successful boundary emits `save_point` and flushes writes created there.
7. A fresh snapshot is built before another provider request.

Persistence is an explicit port operation, not an event subscriber. Subscribers
therefore observe committed transcript state.

## Hook Reducers

`AgentEventBus.emitHook()` owns event-specific reduction:

- `context`: sequential message transformation;
- `before_agent_start`: message aggregation and system-prompt chaining;
- `before_provider_request`: ordered stream-option patches with deletion;
- `before_provider_payload`: sequential payload transformation;
- `tool_call`: first blocking result wins;
- `tool_result`: sequential patch accumulation;
- `session_before_compact`: last meaningful result, with early cancel.

The engine calls only the typed emitter and does not access handler storage.

## Steering and Abort

Normal steering appends to the Session steering queue and is consumed by the
active run at its next safe point.

Interrupting steering first completes the queue update, then asks the run
control channel to interrupt only an active provider inference. A provider's
partial aborted assistant message is committed, the turn reaches a save point,
steering is drained, and the same run continues.

Whole-run abort clears steer/follow-up queues, preserves next-turn input, aborts
the signal used by provider and tools, and waits for run settlement. It never
converts into steering continuation.

## Settlement

After the engine returns an `AgentRunOutcome`, `AgentSession` enters
`settling`. It flushes remaining writes, creates the final `AgentRunResult`, and
emits one correlated `run_settled` envelope. Terminal envelope delivery failure
cannot recursively rewrite the already-final result.

The current handle is cleared and state becomes `idle` only after terminal
listeners finish. Reentrant `startRun()` from an awaited terminal listener is
therefore rejected instead of racing the old control channel.

## Runtime Configuration

`Agent.updateSession()` resolves model references and, for model changes,
requires a persisted credential with a current successful online validation.
The provider/model reference changes atomically; changing a provider alone is
not representable. `NodeSessionHost` appends complete `loopiq.session_config`
custom entries. The latest valid entry restores provider/model, thinking level,
and active tool names. Configuration entries are excluded from model context.
Changes made while running are queued on `SessionWriter` and flushed at the next
save point; idle changes flush before returning.

The Agent-wide default is an atomic provider/model pair in `agent.json`.
`updateConfiguration()` validates registration and catalog membership but does
not require a credential. It affects new Sessions only. A new Session can
therefore be configured before its provider credential is supplied; its run
fails preflight until the credential exists.

## Provider Credentials

Provider implementations are registered during `createAgent({ dataDir })`
without login or network access. Explicit Agent operations add, validate,
replace, and remove credentials. API-token and OAuth UI are supplied through an
adapter-neutral prompt/event interface.

A candidate credential is validated online before durable replacement. Failed
validation preserves an existing credential. Validation state is cached in
memory with a TTL, is bound to the exact durable credential value, and
distinguishes missing, unchecked, valid, invalid, and temporarily unavailable.
A replacement by another process invalidates the cached result. Removing a
credential leaves provider registration, the global default, and Session
configuration unchanged.

Credential replacement/removal returns `provider_busy` while an active run uses
that provider or is preflighting its authentication. Credential mutation also
holds an exclusive in-process guard for the complete login, validation, and
persistence operation, so new runs cannot enter preflight midway through a
replacement or removal. This prevents account or authentication changes between
provider calls within one run.

## Current Limitations

- Automatic compaction is not integrated into `AgentRun` yet.
- Provider retry remains delegated to provider stream options.
- Credential validation currently uses a catalog model for a minimal
  authenticated request and can consume billable tokens.
- A valid provider credential does not guarantee account entitlement to every
  catalog model.
- In-flight provider/tool work is not recoverable after process crash.
- The Node writer lease is an exclusive local lock file; stale-lock recovery is
  not implemented.
- Full hook source metadata, cleanup scopes, and configurable hook error modes
  are not implemented.
- One Session does not admit multiple simultaneous AgentRuns.

## Tests

Co-located tests cover the Agent facade, concurrent Sessions, synchronous busy
reservation, stale-command rejection, run-correlated envelopes,
inference-only steering, event-specific hook reducers, host single-flight open,
config restore, writer lease contention, and running close/delete rejection.
