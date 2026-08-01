# Agent Runtime Lifecycle

Status: Implemented behavior

Last audited: 2026-08-01

This document defines the public `Agent` lifecycle and its internal split
between `AgentEngine`, `AgentRun`, `AgentSession`, and
`AgentSessionManager`. The
detailed run algorithm is documented in [`agent-run.md`](./agent-run.md), and
multi-Session ownership is documented in
[`multi-session-runtime.md`](./multi-session-runtime.md).

## Ownership

- `Agent` is a thin adapter-facing facade. Each method delegates once to the
  owner of that command and never receives a concrete engine or Session.
- `createAgent()` is the composition root. It constructs and wires subsystems
  but implements no runtime command workflow.
- `ModelRuntime` owns the supported provider registry, model catalog, persisted
  credentials, same-Provider mutation exclusion, switchable-model policy,
  online validation state, and shared model capabilities.
- `AgentSettings` owns the loaded Agent configuration, update validation,
  persistence ordering, Session defaults, and Provider request-policy view.
- `AgentEngine` is an internal Session-stateless execution owner. It owns model
  lookup/streaming, the static System Prompt imported from
  `packages/agent/src/prompts/system-prompt.ts`, Provider request policy, and Turn
  snapshot construction. It shares one stateless `ContextManager` and retains
  no current Session or run.
- Each `engine.run()` call creates one short-lived `AgentRun` containing mutable
  provider/tool-loop state for that request.
- `AgentSession` owns one loaded Session's Store, environment, default tool
  construction and instances, Provider Session-resource cleanup, incrementally
  maintained message context, configuration, steering queue, event sequence, and
  active-run control.
- Internal `AgentSessionManager` owns Session-facing commands, discovery,
  single-flight open, the Agent-Home Session-store filesystem, writer leases,
  create/open/list/close/delete/shutdown, and Workspace environment lifecycle.

One `AgentSession` admits one structural run at a time. Different Sessions can
call the same engine concurrently.

## Run Reservation and Identity

`Agent.run(sessionId, input)` delegates to `AgentSessionManager`, which resolves
the internal Session and immediately calls `AgentSession.startRun(input)`. It
does not inspect, validate, refresh, or reserve the selected Provider
credential. `startRun()` is synchronous: it
validates input, creates a
unique `runId` and `AgentRunController`, changes the Session from `idle` to
`running`, publishes the current handle, and only then starts asynchronous run
execution, whose first step captures the synchronous snapshot. The Agent method
is asynchronous only because opening an unloaded Session may require I/O.

Authentication is resolved later by `@loopiq/ai` when an actual Provider request
starts. Missing, revoked, or concurrently removed credentials therefore do not
make `Agent.run()` reject before a handle exists. The request reports its normal
Provider/authentication error through the Run result and `run_settled` event.
An OAuth refresh, when required, also occurs on that request path and is
persisted through the credential-store lock.

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

At Run start, `AgentSession` copies its in-memory message context once into
`AgentRunInput`. Separately, it supplies mutable runtime selection to
`AgentEngine`, which constructs `TurnState` snapshots from:

- current model and thinking level;
- the Engine-owned current Agent Provider request policy;
- Session-created tools;
- the Engine-owned static System Prompt;
- the durable Session ID used for provider affinity.

The engine receives the initial messages and initial snapshot in
`AgentRunInput`. `AgentRun` maintains those messages incrementally for the rest
of the Run. At every successful Turn save point it asks the run-bound port for a
fresh configuration snapshot without rebuilding or copying the full message
history. Configuration changes therefore affect a later Provider request
without mutating an in-flight request.

## Port Boundary

`AgentRun` cannot access `AgentSession`, `JsonlSessionStore`, or `SteeringQueue`
directly. Its `AgentRunPort` provides only:

- steering drain;
- complete-message commit;
- durable context-compaction commit;
- pending Session-state flush;
- next-snapshot construction;
- notification dispatch.

The port closure is bound to one `(sessionId, runId)` pair and validates the
current run before every Session mutation or callback. Concurrent engine calls
therefore cannot select Session state through shared mutable engine fields.

## Persistence and Event Ordering

The implemented ordering is:

1. `message_start` and bounded assistant `message_update` deltas are emitted as
   progress. Provider partial messages remain internal to `AgentRun`.
2. A complete user, assistant, or tool-result message is appended to the JSONL
   Store and then added to the loaded in-memory context.
3. Only after append succeeds is `message_end` emitted.
4. Required pre-request compaction appends its checkpoint, replaces the loaded
   Session context, replaces the Run context, and then emits completion.
5. `turn_end` listeners are awaited while their error is captured.
6. Pending Session state is flushed even when a `turn_end` listener failed.
7. A successful boundary emits `save_point` and flushes state created there.
8. A fresh snapshot is built before another provider request.

Persistence is an explicit port operation, not an event subscriber. Subscribers
therefore observe committed transcript state.

## Notifications

`AgentSession` dispatches read-only envelopes directly to its subscribers.
There is no hook registration or return-valued interception channel in the
current runtime. A future plugin system must introduce its registration API and
execution semantics together instead of leaving unreachable hook contracts in
the core loop. Assistant `message_update` notifications contain only content
kind, content index, and delta where applicable; consumers receive the complete
assistant message from `message_end`.

## Steering and Abort

Normal steering appends to the Session steering queue and is consumed by the
active run at its next safe point.

Interrupting steering first completes the queue update, then asks the run
control channel to interrupt only an active provider inference. A provider's
partial aborted assistant message is committed, the turn reaches a save point,
steering is drained, and the same run continues.

Whole-run abort clears queued steering, aborts the signal used by provider and
tools, and waits for run settlement. It never converts into steering
continuation.

## Settlement

After the engine returns an `AgentRunOutcome`, `AgentSession` enters
`settling`. It flushes remaining state, creates the final `RunResult`, and
emits one correlated `run_settled` envelope. Terminal envelope delivery failure
cannot recursively rewrite the already-final result.

The current handle is cleared and state becomes `idle` only after terminal
listeners finish. Reentrant `startRun()` from an awaited terminal listener is
therefore rejected instead of racing the old control channel.

## Runtime Configuration

`Agent.updateSession()` delegates to `AgentSessionManager`. For model changes,
the manager asks the narrow `ModelRuntime.resolveSwitchableModel()` capability
to require a persisted credential with a current successful online validation.
The provider/model reference changes atomically; changing a provider alone is
not representable. `AgentSession` appends complete `session_config` entries
through `JsonlSessionStore`. The latest valid entry restores provider/model and
thinking level. Configuration entries are excluded from model context. Changes
made while running replace one pending configuration snapshot and flush at the
next save point; idle changes append before returning.

`AgentSettings` owns the loaded snapshot whose durable `agent.json` form contains
the atomic default provider/model pair,
the default thinking level (`high` when first created), and the safe Provider
request policy. Default model and thinking changes affect only new Sessions;
existing Sessions retain their JSONL-persisted values. A default model update
validates registration and catalog membership but does not require a credential,
so its actual Provider request may still fail until a credential is supplied.

Provider request policy is process-wide rather than Session-persisted. It
contains transport, timeout, Provider retry count, retry-delay cap, and cache
retention. `updateConfiguration()` updates the policy snapshot and `agent.json`;
every turn snapshot reads the current value, so the next Provider request sees
the update while an in-flight request remains unchanged. Request headers and
metadata are not part of the Agent runtime configuration API.

## Provider Credentials

Provider implementations are registered during `createAgent()`
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

`ModelRuntime` owns credential replacement/removal and keeps it deliberately
independent from active Runs.
A request that already resolved authentication may finish with the old
credential; a later request observes the replacement or removal and succeeds or
fails naturally. The Agent does not attempt to preserve one credential identity
for an entire Run. It only serializes overlapping explicit credential mutations
for the same Provider so two login/removal operations do not overwrite each
other unpredictably.

## Current Limitations

- Agent configuration controls Provider/SDK retry attempts, while higher-level
  Agent retry remains unimplemented.
- Credential validation currently uses a catalog model for a minimal
  authenticated request and can consume billable tokens.
- A valid provider credential does not guarantee account entitlement to every
  catalog model.
- In-flight provider/tool work is not recoverable after process crash.
- The Node writer lease is an exclusive local lock file; stale-lock recovery is
  not implemented.
- One Session does not admit multiple simultaneous AgentRuns.

## Tests

Co-located tests cover the Agent facade, concurrent Sessions, synchronous busy
reservation, stale-command rejection, run-correlated envelopes,
inference-only steering, manager single-flight open, config restore, writer
lease contention, and running close/delete rejection.
Credential tests also cover request-time resolution and removal during an
active Run. Context tests cover threshold and cut-point planning, tool-call
integrity, incremental summaries, durable replay, persistence failure, and
whole-run abort during summary generation.
