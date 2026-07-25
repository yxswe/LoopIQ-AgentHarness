# AgentRun: Execution Flow and Design Guide

Status: Implemented behavior

Last audited: 2026-07-22

This document explains the implemented `AgentRun` behavior for readers with no
prior knowledge of LoopIQ Agent. It focuses on the execution kernel: how
one accepted user request becomes one or more model turns, tool calls, durable
messages, events, and a final outcome.

For the broader runtime lifecycle, see
[`agent-runtime.md`](./agent-runtime.md). For multi-Session ownership and host
contracts, see [`multi-session-runtime.md`](./multi-session-runtime.md).

## 1. Where AgentRun Fits

LoopIQ Agent is an application. A Server or CLI adapter asks the
`Agent` to create or open durable Session state, submits a user request by
Session identity, and receives streamed progress plus a terminal result. The
model may answer directly, request tools, inspect tool results, and repeat that
cycle before producing its final answer.

Five runtime objects divide the work:

```text
Application adapter (CLI or server)
                |
                v
              Agent
     identity routing and composition
                |
                v
          AgentSession
     durable state and lifecycle
                |
                | immutable input + run-bound port
                v
           AgentEngine
       shared stateless factory
                |
                | creates one per request
                v
            AgentRun
   mutable model/tool loop for one run
```

- `Agent` is the sole adapter-facing entry and returns only snapshots, handles,
  results, and events.
- `AgentEngine` retains only the shared model-streaming capability. It has no
  current Session or current run.
- `AgentSession` owns durable history, configuration, queues, hooks, event
  subscribers, persistence, and the one-active-run lifecycle.
- `AgentRun` is short-lived. It owns the mutable context, current snapshot,
  model/tool loop, and messages produced by one accepted request.
- `AgentRunPort` is the narrow boundary through which the run asks its Session
  to consume queues, commit messages, flush writes, create snapshots, and
  dispatch events or hooks.

This ownership split allows one `AgentEngine` to execute runs from different
Sessions concurrently without storing a global "current Session" pointer.

## 2. Essential Vocabulary

The following terms describe different scopes and should not be used
interchangeably:

| Term | Meaning | Lifetime |
| --- | --- | --- |
| Session | Durable conversation history plus runtime configuration and resources | Across many runs and process restarts |
| Run | One accepted user request, including all model/tool iterations and queued continuation messages it consumes | From `startRun()` until settlement |
| Turn | One assistant response plus the tool calls and tool results produced from that response | One iteration inside a run |
| Provider request | One call to `Models.streamSimple()` | Usually one per turn |
| Inference scope | The abort scope around one provider request | Only while that provider request is active |
| Turn snapshot | A stable view of history, model, prompt, tools, resources, and stream options | One provider turn |
| Save point | A turn boundary where pending writes are flushed before the next snapshot | After `turn_end` |
| Settlement | Session-owned final flushing, terminal notifications, and return to `idle` | After `AgentRun` returns |

A run can therefore contain several turns:

```text
Run
  Turn 1: model requests tools -> tools execute
  Turn 2: model reads tool results -> requests another tool
  Turn 3: model reads results -> gives final answer
```

## 3. Inputs and Boundaries

### 3.1 AgentRunInput

`AgentRunInput` contains values fixed when the Session accepts the run:

- durable `sessionId`;
- unique `runId`;
- user text and optional images;
- the initial `TurnState` snapshot;
- a read-side `AgentRunControlView`.

The `sessionId` is also passed to the provider for Session-affine caches and
transports. The `runId` correlates commands and events with this exact
execution.

### 3.2 AgentRunPort

The port provides Session-owned capabilities without exposing the entire
`AgentSession`:

| Capability | Port methods | Why the Session owns it |
| --- | --- | --- |
| Queue consumption | `takeNextTurn`, `drainSteering`, `drainFollowUp` | Queue storage, update events, and drain rollback remain Session-owned |
| Durable transcript | `commitMessage` | The engine must not depend on JSONL or another storage backend |
| Write boundary | `hasPendingWrites`, `flushPendingWrites` | The Session owns buffered configuration and storage writes |
| Snapshot refresh | `createTurnSnapshot` | Building context requires Session history and mutable configuration |
| Notifications | `emit` | Event subscribers and envelope sequencing are Session-scoped |
| Interceptable hooks | `emitHook` | Handler registration and event-specific result reduction are Session-scoped |

The concrete port is a closure bound to one `runId`. Before it mutates or reads
Session-owned run state, it verifies that the ID still matches the Session's
current run. A delayed callback cannot accidentally write into a newer run.

### 3.3 Run control

The control channel deliberately exposes two cancellation levels:

- `runSignal` aborts the whole run, including provider and tool work;
- `openInferenceScope()` creates a signal for one provider request that can be
  interrupted for steering without aborting the whole run.

Only `AgentSession` owns the controller methods that initiate abort or
interruption. `AgentRun` receives only the read-side view.

## 4. End-to-End Lifecycle

### Phase A: Agent routing and synchronous Session reservation

`Agent.run(sessionId, input)` resolves the internal Session and calls
`AgentSession.startRun()`. The Session validates that the input is non-empty and
it is `idle`, then performs these operations synchronously:

1. creates a unique `runId`;
2. creates a run controller;
3. creates the result promise;
4. changes Session state to `running`;
5. publishes the current run record;
6. returns an `AgentRunHandle` while starting asynchronous execution.

Reservation is synchronous so two callers cannot both pass an asynchronous
"is idle" check. A second `startRun()` immediately receives a busy error.

### Phase B: Initial snapshot and AgentRun construction

The Session builds the first `TurnState` from:

- persisted model-visible history;
- the current model and thinking level;
- the current system prompt;
- active tools;
- skills and prompt templates;
- copied stream options;
- durable Session metadata.

It then calls the shared engine with the input and a run-bound port. The engine
immediately constructs a fresh `AgentRun` and calls `execute()`. No mutable run
state is stored on the engine.

### Phase C: Prompt preparation

`AgentRun` prepares the initial messages in this order:

1. take all messages from the next-turn queue;
2. append the newly submitted user message;
3. invoke the `before_agent_start` hook;
4. append any extra messages returned by that hook.

The same hook may override the initial system prompt. The run then combines the
snapshot's persisted history with these new prompt messages to form the first
model context.

The engine emits:

```text
agent_start
turn_start
message_start / message_end for each initial prompt message
```

Every `message_end` follows the commit rule described in
[Persistence and ordering](#7-persistence-and-ordering).

### Phase D: Provider and tool loop

The main loop begins by draining any steering messages that arrived while the
initial snapshot or hooks were running. For every turn, it then performs the
following steps.

#### D1. Inject pending messages

Steering or follow-up messages selected for this turn are emitted and committed
before the provider request. They are added to both the model context and the
run's aggregate message list.

#### D2. Transform the provider context

Before each provider request, the `context` hook receives a copy of the current
messages. It may replace the messages used for this request.

This transformation is request-local. It does not rewrite the durable Session
transcript unless a hook separately causes a supported Session mutation.

The resulting agent messages are converted into provider-compatible messages.
The active system prompt and active tools come from the current snapshot.

#### D3. Prepare the provider request

The run clones the snapshot's stream options and invokes
`before_provider_request`. Hook-produced patches may change options for this
request without mutating the snapshot.

The run then opens a new inference scope and calls `Models.streamSimple()` with:

- the current model;
- converted context and active tools;
- the current reasoning level;
- copied and hook-patched stream options;
- the durable `sessionId`;
- the inference-scope abort signal.

Immediately before a provider payload is sent, `before_provider_payload` may
transform it. When an HTTP response is available, `after_provider_response` is
emitted with status and copied headers.

#### D4. Stream the assistant message

Provider events are translated into the public message lifecycle:

```text
provider start  -> message_start
text/thinking/tool-call deltas -> message_update
provider done or error -> finalize message -> message_end
```

Partial assistant messages are visible through progress events but are not
persisted on every delta. The final assistant message is committed before its
`message_end` notification.

The inference scope is always closed in a `finally` block, preventing a later
steering command from targeting an already-finished provider request.

#### D5. Handle terminal provider states

If the final assistant message has `stopReason: "error"` or
`stopReason: "aborted"`, the run emits `turn_end`, reaches a save point, emits
`agent_end`, and stops the model/tool loop.

There is one exception: an aborted assistant message caused specifically by an
interrupting steering command is not terminal for the run. That scenario is
handled in [Steering](#8-steering).

#### D6. Execute requested tools

If the assistant message contains tool calls, the run delegates the batch to
`executeToolCalls()`.

For each call, tool execution performs:

1. `tool_execution_start` notification;
2. tool lookup and optional argument preparation;
3. schema validation;
4. `tool_call` hook, which may block execution;
5. tool execution with the whole-run abort signal;
6. optional `tool_execution_update` notifications;
7. `tool_result` hook, which may patch the result;
8. `tool_execution_end` notification;
9. creation and persistence of a `toolResult` message.

Missing tools, invalid arguments, hook blocks, and thrown tool errors are
normally converted into error tool-result messages. They do not automatically
fail the entire run; the model can inspect the error and decide what to do next.

If any tool in the batch declares sequential execution, the batch executes in
order. Otherwise, prepared calls execute concurrently. Parallel batches retain
assistant source order for the final tool-result messages even when completion
events arrive in a different order.

The engine normally starts another provider turn after tool results. It stops
that continuation when every finalized result in the batch has
`terminate: true`.

#### D7. Close the turn and refresh state

After the assistant response and any tools, the run:

1. emits `turn_end`;
2. inspects and flushes pending Session writes;
3. emits `save_point` when the turn boundary succeeds;
4. flushes writes before snapshot construction;
5. asks the Session for a fresh `TurnState`;
6. rebuilds context from the refreshed persisted state;
7. drains steering messages for the next safe point.

Refreshing the snapshot allows model, thinking, active-tool, system-prompt, and
history changes to affect a later provider request without mutating an
in-flight request.

The current implementation refreshes after every successful turn, including a
final successful turn that does not ultimately need another provider request.
Consequently, a dynamic system-prompt provider may be called once more near the
end of a successful run. If that refresh fails, the otherwise completed turn
enters failure reporting. This is part of the current lifecycle contract, not an
optimization requirement.

### Phase E: Follow-up drain and completion

When a turn has no more tool continuation or steering work, the run drains the
follow-up queue. If it receives messages, they become pending input and the same
run starts another turn. Otherwise, the engine emits `agent_end` and exits the
loop.

`execute()` classifies the result by inspecting the last assistant message:

- `stopReason: "aborted"` -> `status: "aborted"`;
- `stopReason: "error"` -> `status: "failed"`;
- another assistant stop reason -> `status: "completed"`;
- no assistant message -> invalid-state failure.

The resulting `AgentRunOutcome` contains messages produced by the run and the
terminal classification. It does not contain historical Session messages.

### Phase F: Session settlement

Settlement occurs outside `AgentRun`. After the engine returns,
`AgentSession`:

1. verifies that the `runId` is still current;
2. changes state from `running` to `settling`;
3. flushes remaining writes;
4. creates and emits the terminal `run_settled` envelope;
5. disposes run control;
6. clears the current run and returns to `idle`;
7. resolves the handle result.

The Session remains non-idle while awaited terminal observers are running. This
prevents a new run from racing callbacks that still belong to the old run.

Failure to deliver the final `run_settled` envelope does not rewrite an already
final result. A final persistence failure before that envelope can change the
result to `failed`.

## 5. Core Loop in Pseudocode

The implementation can be reduced to the following conceptual algorithm:

```text
prepare current user input and next-turn messages
run before_agent_start hook
emit agent_start and first turn_start
commit prepared prompt messages

pending = drain steering

loop:
  while the previous response requires tool continuation
        or pending messages exist:
    emit turn_start, except for the already-open first turn
    commit pending messages

    assistant = stream one provider response

    if provider inference was interrupted for steering:
      close turn and save
      refresh snapshot
      pending = drain steering
      continue

    if assistant is error or whole-run aborted:
      close turn and save
      emit agent_end
      return

    execute and commit requested tool results
    close turn and save
    refresh snapshot
    pending = drain steering

  pending = drain follow-up
  if pending is empty:
    break

emit agent_end
classify the final assistant message
```

## 6. Event Timeline Examples

### Direct answer without tools

```text
before_agent_start hook
agent_start
turn_start
  user message_start
  commit user message
  user message_end
  context / provider hooks
  assistant message_start
  assistant message_update ...
  commit final assistant message
  assistant message_end
turn_end
flush -> save_point -> flush -> refresh snapshot
agent_end
run_settled
```

### Tool-using run

```text
turn 1
  user message
  assistant message containing tool calls
  tool_execution_start/update/end
  committed toolResult message
  turn_end -> save point -> snapshot refresh

turn 2
  assistant reads persisted tool result
  final assistant message
  turn_end -> save point -> snapshot refresh

agent_end -> Session settlement -> run_settled
```

The next provider turn is rebuilt from persisted Session history rather than
depending only on the previous turn's in-memory array.

## 7. Persistence and Ordering

Persistence is an explicit engine-to-Session operation, not an event
subscriber. This preserves a crucial invariant:

```text
message_start and message_update may describe transient progress

complete message
  -> commitMessage(message)
  -> emit message_end
```

Therefore, a `message_end` observer can read the Session and find that message.
If the observer throws, the committed transcript is not rolled back.

At a turn boundary, the ordering is:

```text
emit turn_end and capture observer failure
inspect pending writes
flush pending writes
rethrow the turn_end failure, if any
emit save_point
flush before the next snapshot or agent_end
```

This ordering ensures that buffered runtime-configuration mutations reach a
stable boundary even if a `turn_end` observer fails.

The final `AgentRunOutcome` summarizes work that has already been committed
incrementally. It is not a transaction that writes the whole run only at the
end. After a process crash, committed JSONL entries remain, but an in-flight
provider stream or tool call cannot be resumed.

## 8. Steering

Steering adds a user instruction to the currently active run. Every steering
command includes the target `runId`; stale IDs are rejected instead of being
redirected to whatever run happens to be active.

### Normal steering

Normal steering queues the message without cancelling provider or tool work.
The run consumes it at a safe point:

- before the first provider request if it arrived during initial setup;
- after a completed turn and snapshot refresh;
- after current tool execution completes.

This avoids injecting a message into the middle of an inconsistent tool or
provider state.

### Interrupting steering

With `interruptCurrentInference: true`, the Session first enqueues the message,
awaits the `queue_update` notification, and then requests provider-only
interruption.

If inference is active:

1. the provider request is aborted with reason `steer`;
2. the partial aborted assistant message is finalized and committed;
3. the interrupted turn reaches `turn_end` and a save point;
4. a fresh snapshot is created;
5. queued steering is drained;
6. the same run continues with another provider turn.

If no provider inference is active, such as during tool execution, interruption
returns false. The steering message remains queued and is consumed at the next
safe point.

Queue insertion happens before inference interruption. If the queue-update
notification fails, the steering call throws and the provider is not
interrupted. In the current implementation the newly inserted steering message
remains queued; insertion rollback is not implemented.

## 9. Queue Roles

The runtime distinguishes three queue intents:

| Queue | Consumption point | Purpose |
| --- | --- | --- |
| Steering | Before the first request or after a completed turn | Redirect the active run |
| Follow-up | When the current model/tool chain would otherwise finish | Continue the same run with another user message |
| Next-turn | At the start of a later user-initiated run | Preserve input for the next run |

Steering and follow-up drains support `one-at-a-time` and `all` modes. Queue
drains remove selected messages, emit `queue_update`, and restore the messages
if that notification fails.

`Agent.steer(sessionId, runId, ...)` is the public steering command. Follow-up
and next-turn remain internal queue capabilities used by the run port; adding
Agent commands for them requires a separate API decision.

Whole-run abort clears steering and follow-up queues but preserves next-turn
messages.

## 10. Failure and Abort Scenarios

### Provider-reported error

Providers normally finish with an assistant message whose stop reason is
`error`. The message is committed through the normal lifecycle, the turn and
agent close normally, and the outcome is `failed`.

### Whole-run abort

`Agent.abort(sessionId, runId)` routes to the internal Session, which clears
steering and follow-up work, aborts `runSignal`, and waits for settlement. The
signal reaches the active provider request and tool execution. The resulting
aborted assistant artifact is committed, and the outcome is normally
`aborted`.

Whole-run abort takes precedence over steering interruption: an aborted run
never continues merely because a steering message was also present.

Dynamic system-prompt providers do not currently accept an `AbortSignal`. An
abort during initial snapshot construction waits for that callback to finish;
the engine then starts with an already-aborted run signal and emits the normal
aborted artifact.

### Tool failure

Missing tools, invalid arguments, blocks, and thrown tool errors become error
tool-result messages. They are durable inputs to the next model turn rather
than immediate run failures.

### Hook, event, persistence, or unexpected loop failure

Once the agent lifecycle has started, unexpected thrown errors enter failure
reporting. The run tries to create a synthetic assistant failure message and
sends it through the normal message, turn, save-point, and agent-end lifecycle.

Errors during the earlier prompt-preparation phase, including next-turn drain
or `before_agent_start`, occur before that failure-reporting boundary. They
produce a failed outcome without a synthetic assistant artifact. Initial
snapshot construction happens even earlier in `AgentSession` and can fail the
same way.

If lifecycle failure reporting also fails, `execute()` returns a failed outcome
with an aggregate error and may have no final assistant message.

Because messages are committed incrementally, a failed outcome with a short or
empty `messages` array does not imply that no earlier transcript entries were
persisted.

### Settlement failure

An engine outcome can be changed to `failed` if final Session flushing fails.
Failure of a `run_settled` observer itself is isolated because that event
describes a result that has already been finalized.

## 11. Hooks and Their Place in the Flow

Hooks are interceptable and may influence execution. Notifications are
read-only observations. `AgentRun` uses the following hooks:

| Hook | Timing | Effect |
| --- | --- | --- |
| `before_agent_start` | Before agent lifecycle events | Add prompt messages or override the initial system prompt |
| `context` | Before every provider request | Transform request-local messages |
| `before_provider_request` | Before stream creation | Patch stream options |
| `before_provider_payload` | Immediately before provider payload submission | Transform provider payload |
| `tool_call` | After validation, before tool execution | Block a tool call |
| `tool_result` | After execution, before result finalization | Patch content, details, error state, or termination |

Hook handlers are reduced according to event-specific rules owned by the
Session event bus. The engine consumes only the typed final result and does not
know how handlers are registered.

Notifications are awaited, so they participate in ordering and can fail a run.
Network adapters should therefore buffer outbound SSE or similar I/O instead
of attaching slow clients directly to the core awaited path.

## 12. Snapshot Isolation and Dynamic Configuration

Each provider turn uses a snapshot rather than reading live Session fields
during the request. This has two benefits:

1. a model request sees a self-consistent set of model, prompt, tools, history,
   and stream options;
2. configuration changes made during a turn become visible only after the next
   save point and snapshot refresh.

For example, changing the model while a provider stream is active does not
replace that stream's model. If the run needs another turn, the refreshed
snapshot can select the new model.

Snapshot construction belongs to the internal `AgentSession` because it reads
durable history and Session-owned resources. `AgentRun` only consumes snapshots.

## 13. Concurrency and Identity Guarantees

One `AgentSession` admits one active structural run. Different Sessions may run
concurrently through the same engine:

```text
Session A -> port A -> AgentRun A --+
                                     +-> shared AgentEngine / Models
Session B -> port B -> AgentRun B --+
```

Isolation depends on ownership rather than a global scheduler:

- every engine call creates a distinct `AgentRun`;
- every run receives a distinct control channel;
- every port closure is permanently bound to one Session and run ID;
- turn snapshots contain copied Session-specific values;
- the shared engine contains no mutable current-run fields.

The runtime does not coordinate filesystem or shell conflicts between
different Sessions, even when they share a working directory. That is outside
the AgentRun concurrency contract.

## 14. Design Principles

### Keep the engine stateless, not the execution

Agent execution is inherently stateful: partial assistant content, current
context, pending messages, and active snapshots all change over time. The
design makes that state explicit and short-lived on `AgentRun` instead of
pretending it does not exist or storing it on a shared engine singleton.

### Depend on capabilities, not concrete Session objects

The port follows dependency inversion. The engine defines the minimal
capabilities it needs, while the Session supplies them. This prevents engine
code from reaching into unrelated Session configuration or persistence
internals and makes isolated engine tests possible.

### Treat durable messages as lifecycle facts

Progress can be transient, but a completed message is committed before it is
announced as complete. This makes event consumers, storage, and model context
agree about what has happened.

### Change state only at safe boundaries

Steering, configuration refresh, buffered writes, and future compaction belong
at explicit boundaries. The run never swaps model configuration halfway
through a provider request or injects steering into the middle of a tool call.

### Separate interruption intent

Provider-only interruption means "stop generating and reconsider this new
instruction." Whole-run abort means "terminate this execution." Encoding both
with one undifferentiated abort signal would make reliable continuation
impossible.

### Make terminal classification explicit

Persisted failure or aborted messages remain part of the transcript, while the
typed outcome gives headless callers an unambiguous `completed`, `aborted`, or
`failed` status. Adapters can then map results to HTTP responses or CLI exit
codes without parsing assistant text.

## 15. Current Limitations

- Automatic context compaction is not integrated into `AgentRun`; only helper
  primitives exist.
- Provider retry is delegated to provider stream options. The run does not own
  a separate retry phase.
- In-flight provider streams and tool calls cannot be resumed after a process
  crash.
- One Session cannot execute multiple AgentRuns simultaneously.
- Dynamic system-prompt callbacks do not yet accept the run abort signal.
- Follow-up and next-turn queues do not currently have public Agent commands.
- External resource conflicts across different Sessions are not coordinated.

## 16. Source Map

The primary implementation files are:

- `packages/agent/src/agent.ts` — sole application entry and identity router;
- `packages/agent/src/engine/agent-engine.ts` — shared engine factory;
- `packages/agent/src/engine/agent-run.ts` — run algorithm and event
  ordering;
- `packages/agent/src/engine/agent-run-port.ts` — Session capability
  boundary;
- `packages/agent/src/engine/agent-run-control.ts` — whole-run and
  provider-only cancellation;
- `packages/agent/src/engine/agent-run-outcome.ts` — terminal outcome;
- `packages/agent/src/runtime/agent-session.ts` — reservation, concrete
  port, settlement, and run identity checks;
- `packages/agent/src/core/turn-state.ts` — snapshot and context
  construction;
- `packages/agent/src/core/tool-execution.ts` — tool batch lifecycle;
- `packages/agent/src/queue/message-queues.ts` — queue drain and rollback
  behavior;
- `packages/agent/src/base/events.ts` — notification and hook contracts.
