# Agent Runtime Lifecycle

This document describes the implemented lifecycle split between `AgentEngine`,
`AgentRun`, `AgentSession`, and the compatibility `AgentHarness`. The detailed
multi-Session and headless contract is
[`headless-multi-session-engine.md`](./headless-multi-session-engine.md).

## Ownership

- `AgentEngine` is a Session-stateless capability created by
  `createAgentEngine({ models })`. It retains no current Session or run.
- Each `engine.run()` call creates one short-lived `AgentRun` containing the
  mutable provider/tool loop state for that accepted request.
- `AgentSession` owns one durable Session's storage, writer, environment, tools,
  config, queues, hooks, event sequence, and active-run control.
- `NodeSessionHost` owns loaded Session discovery, single-flight open, writer
  leases, close/delete/shutdown, and per-Session tool construction.
- `AgentHarness` is a backward-compatible one-Session facade.

One `AgentSession` admits one structural run at a time. Different Sessions can
call the same engine concurrently. Cross-Session working-directory or external
resource conflicts are outside this subsystem.

## Run Reservation and Identity

`AgentSession.startRun(input)` is synchronous. It validates input, creates a
unique `runId` and `AgentRunController`, changes the Session from `idle` to
`running`, publishes the current handle, and only then starts asynchronous
snapshot construction.

This prevents two callers from passing an asynchronous idle check. The returned
handle contains the durable `sessionId`, unique `runId`, and a result promise.

Steer and abort are explicit:

```ts
session.steer(runId, input, options);
session.abort(runId);
```

Both compare `runId` with the Session's current handle. A delayed command from a
settled run is rejected with `AgentHarnessError("invalid_state")`; it is never
redirected to a newer run.

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

System-prompt providers do not yet accept an AbortSignal. A run aborted during
snapshot creation completes that callback, then enters the engine with an
already-aborted run signal so the normal aborted assistant artifact is emitted.

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

The implemented ordering preserves the previous runtime contract:

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
The broader phantom-result/source-metadata/cleanup API in
[`hooks.md`](./hooks.md) remains future work.

## Steering and Abort

Normal steering appends to the Session steering queue and is consumed by the
active run at its next safe point.

Interrupting steering first commits the queue update, then asks the run control
channel to interrupt only an active provider inference. If no inference is
active, the message remains queued. A provider's partial aborted assistant
message is committed, the turn reaches a save point, steering is drained, and
the same run continues.

Whole-run abort clears steer/follow-up queues, preserves next-turn input, aborts
the run signal used by provider and tools, and waits for run settlement. During
settlement the compatibility `abort` notification is emitted after `settled`
and before the final `run_settled` envelope. Abort never converts into steering
continuation.

## Settlement

After the engine returns an `AgentRunOutcome`, `AgentSession` enters
`settling`. It flushes remaining writes, emits the compatibility `settled`
notification, creates the final `AgentRunResult`, and emits a correlated
`run_settled` envelope. Terminal envelope delivery failure cannot recursively
rewrite the already-final result.

The current handle is cleared and state becomes `idle` only after terminal
listeners finish. Reentrant `startRun()` from an awaited terminal listener is
therefore rejected instead of racing the old control channel.

## Runtime Configuration

`NodeSessionHost` appends complete `loopiq.session_config.v1` custom entries.
The latest valid entry restores provider/model, thinking level, and active tool
names. Configuration entries are excluded from model context. Changes made while
running are queued on `SessionWriter` and flushed at the next save point;
idle changes flush before returning.

## Compatibility Facade

`AgentHarness.create()` still accepts `cwd`, a direct `sessionPath`, models,
model, tools, and other options. Internally it creates one private engine and
one `AgentSession`.

`send()` retains phase-dependent behavior only on this facade:

- idle starts a run and maps its typed result back to the final assistant
  message;
- busy captures `currentRunId` and delegates to explicit steering;
- the Session revalidates that ID, preventing a settlement race.

Legacy `subscribe()` exposes naked notification events. New
`AgentSession.subscribe()` consumers receive `AgentEventEnvelope` with Session
and run identity.

## Current Limitations

- Automatic compaction is not integrated into `AgentRun` yet.
- Provider retry remains delegated to provider stream options.
- In-flight provider/tool work is not recoverable after process crash.
- The Node writer lease is an exclusive local lock file; stale-lock recovery is
  not implemented.
- Full hook source metadata, cleanup scopes, and configurable hook error modes
  are not implemented.
- One Session does not admit multiple simultaneous AgentRuns.

## Tests

Co-located tests cover:

- concurrent Sessions sharing one engine without context bleed;
- synchronous busy reservation;
- stale steer/abort rejection;
- run-correlated envelopes and terminal events;
- hook reducer chaining, deletion, and early block;
- Node host single-flight open, config restore, writer lease contention, and
  running close/delete rejection;
- existing JSONL storage and built-in tools.
