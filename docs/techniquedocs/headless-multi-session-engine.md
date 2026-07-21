# Headless CLI and Multi-Session Engine Design

Status: Initial implementation complete

Last audited: 2026-07-21

This document combines the roadmap items "CLI & headless entrypoint" and
"Stateless engine serving multiple sessions in parallel". It contains both the
pre-extraction audit and the implemented architecture selected from that audit.
Sections explicitly describing future compaction, richer hook infrastructure,
or operational hardening remain planned.

The canonical current architecture is [`../architect.md`](../architect.md).
Current Session format and invariants are in [`../session.md`](../session.md).
Current lifecycle intent is in [`agent-harness.md`](./agent-harness.md), and the
target hook reducer design is in [`hooks.md`](./hooks.md).

## Implementation Status

Implemented:

- shared `AgentEngine` factory and one short-lived `AgentRun` per request;
- narrow run port, typed outcomes, and separate inference/run cancellation;
- `AgentSession` with synchronous reservation, `runId` validation, settling,
  envelopes, queues, config, hooks, tools, and persistence;
- `NodeSessionHost` create/open/list/close/delete/shutdown, single-flight open,
  durable config restore, per-Session tools, and exclusive writer lock files;
- multi-Session server routes and Session-scoped SSE, with legacy DevUI routes;
- standalone `@loopiq/cli` run/chat/session commands and text/JSON/JSONL output;
- reducer parity and concurrency/lifecycle/host tests.

Still planned or deliberately limited:

- automatic compaction integration;
- the full generic hook context/source/cleanup system from `hooks.md`;
- stale process-lock recovery and stronger cross-platform lease semantics;
- providers other than GitHub Copilot in the default CLI runtime;
- event replay and distributed/multi-host execution.

## Executive Decision

The runtime will be split into four roles:

1. `AgentEngine` is one shared, Session-stateless run factory. It owns provider
   and agent-loop algorithms and only retains concurrency-safe shared services.
2. `AgentRun` is a short-lived object created for every accepted request. It
   owns all mutable state for that run.
3. `AgentSession` owns all mutable state and durable resources for one Session.
   It serializes structural operations for that Session and implements the ports
   consumed by `AgentRun`.
4. `SessionHost` owns the loaded-Session map, discovery, open/close, same-Session
   writer exclusion, and eviction.

```text
CLI / Server / SDK
        |
        v
   SessionHost
   |          |
   v          v
AgentSession A            AgentSession B
   |                          |
   | run(input A, port A)     | run(input B, port B)
   +------------+-------------+
                v
          AgentEngine
          |          |
          v          v
       AgentRun A  AgentRun B
```

The core concurrency contract is:

- one active structural operation per `AgentSession`;
- unrestricted concurrent operations across different Sessions;
- one writable runtime per durable Session store;
- no coordination of files, shell processes, or other external resources
  across different Sessions.

Different Sessions may use the same `cwd` and still run concurrently. External
resource conflict management is intentionally deferred to a separate future
module.

## Audit Scope and Baseline

The audit covered:

- every file under `packages/agent-harness/src/core`;
- `MessageQueues`, `Session`, `SessionWriter`, and JSONL storage;
- event and hook type definitions;
- compaction helpers;
- built-in tool construction and tool execution;
- `Models`, provider auth resolution, lazy streams, provider session resources,
  and provider module-level mutable state;
- the current server factory, HTTP/SSE adapter, and credential store;
- the public `@loopiq/agent-core` export surface and available tests.

Baseline validation at the time of audit:

```text
npm test -w @loopiq/agent-core
10 test files passed, 75 tests passed

npx tsgo --noEmit -p packages/agent-harness/tsconfig.build.json
passed
```

The 75 tests cover Session JSONL storage and built-in tools. They do not cover
the central `AgentHarness`/`TurnRunner` lifecycle, event ordering, steering,
save points, run failure reporting, or multi-Session isolation.

## Current Implementation Audit

### Current call graph

The implemented call graph is:

```text
AgentHarness.send(text)
  |-- phase == idle -> prompt(text)
  |                    |-- phase = turn
  |                    |-- buildTurnStateFromConfig()
  |                    `-- executeTurn()
  |                         |-- take next-turn messages
  |                         |-- before_agent_start hook
  |                         |-- create AbortController
  |                         `-- new TurnRunner(...).run()
  |                              |-- provider streaming
  |                              |-- tool execution
  |                              |-- steer/follow-up drains
  |                              |-- message persistence
  |                              |-- save-point flush/refresh
  |                              |-- failure-message reporting
  |                              `-- markIdle()
  `-- phase != idle -> steer(text)
```

Relevant implementation files:

- [`agent-harness.ts`](../../packages/agent-harness/src/core/agent-harness.ts)
- [`turn-runner.ts`](../../packages/agent-harness/src/core/turn-runner.ts)
- [`turn-state.ts`](../../packages/agent-harness/src/core/turn-state.ts)
- [`tool-execution.ts`](../../packages/agent-harness/src/core/tool-execution.ts)
- [`event-bus.ts`](../../packages/agent-harness/src/core/event-bus.ts)

### `AgentHarness` currently owns both shared and Session state

The current class stores:

- `Models`;
- `ExecutionEnv`;
- `Session` and `SessionWriter`;
- model, thinking level, resources, stream options, tools, and active tools;
- steering and follow-up modes;
- phase, run promise, and run abort controller;
- message queues;
- the event bus and hook registrations.

This makes one `AgentHarness` equivalent to one loaded Session. Creating one
`AgentHarness` per Session can produce concurrency, but it does not produce a
shared stateless engine and repeats shared assembly.

### `TurnRunner` is a run driver, not a reusable singleton

Despite its name, `TurnRunner` drives one complete agent run, which may contain
multiple provider turns and tool batches. It contains mutable
`activeTurnState`, current context, pending messages, model, and reasoning state.

It is already close to the target short-lived `AgentRun`, but its dependencies
still include concrete Session-owned objects:

- `Session`;
- `SessionWriter`;
- `MessageQueues`;
- `AgentEventBus`;
- queue modes;
- `markIdle()` callback;
- snapshot refresh callback.

Therefore `TurnRunner` cannot become a shared `AgentEngine` by renaming it. A
shared engine must create a fresh run object for each request.

### Exact run behavior

For a normal run, `TurnRunner`:

1. emits `agent_start` and `turn_start`;
2. emits and persists every input message;
3. applies the `context` hook before each provider request;
4. converts messages to provider-compatible LLM messages;
5. applies ordered provider-request and payload transformations;
6. calls `Models.streamSimple()` with the turn snapshot's model, reasoning,
   stream options, abort signal, and Session ID;
7. translates provider stream events into assistant message lifecycle events;
8. executes tool calls sequentially or in parallel;
9. persists tool-result messages;
10. emits `turn_end`, flushes pending writes, and emits `save_point`;
11. flushes again for writes created by save-point subscribers;
12. builds a fresh turn snapshot;
13. drains steering and follow-up queues at defined points;
14. emits `agent_end` when no more work remains.

The snapshot refresh in step 12 happens after every successful turn even when
no next provider request is ultimately made. This means the dynamic system
prompt can be called once more at the end of a successful run, and an error in
that refresh can convert an otherwise finished run into failure reporting.
Removing that refresh is a behavior change, not a mechanical optimization.

### Message persistence is part of lifecycle ordering

On `message_end`, the current implementation appends the message before
notifying subscribers:

```text
Session.appendMessage(message)
eventBus.emit(message_end)
```

Subscribers therefore observe committed transcript state. If a subscriber
fails, the message remains persisted. A generic engine must preserve this order
through an explicit persistence port. Persistence must not be implemented as an
ordinary event subscriber.

### Save-point ordering

Current `turn_end` handling is deliberately ordered:

```text
emit turn_end, capturing listener error
inspect pending writes
flush pending writes
rethrow listener error if one occurred
emit save_point
flush writes created by save_point listeners
refresh turn snapshot
```

The engine owns when this sequence occurs. The Session owns how append and flush
are implemented.

### Pending writes are currently an unused skeleton

`SessionWriter` implements `enqueue()`, `hasPending()`, and serial `flush()`, but
the audited source has no caller of `SessionWriter.enqueue()`. Current
`setModel()` and `setThinkingLevel()` mutate memory and emit notifications; they
do not enqueue or persist Session config changes.

The pending-write path must still be preserved because save-point ordering was
designed around it, but runtime-config persistence is a separate new feature and
must not be presented as current behavior.

### Queue behavior

`MessageQueues` contains independent steer, follow-up, and next-turn arrays.
Drains remove messages before emitting `queue_update` and restore them if that
notification fails.

Current public behavior exposes only `send()`:

- idle `send()` starts a prompt;
- any non-idle `send()` enqueues steering;
- `followUp()` and `nextTurn()` exist but are private.

This phase-dependent input contract is unsuitable for deterministic HTTP and
CLI automation. New APIs must separate run start from steering while retaining
`send()` only as a compatibility method.

### Hook reducer behavior is not uniform

The current `AgentEventBus.emitHook()` returns the last non-`undefined` result.
Two provider hooks bypass that generic behavior:

- `before_provider_request` sequentially applies stream-option patches;
- `before_provider_payload` sequentially transforms the payload.

Tool and context hooks use different effective reduction rules. The target hook
design in [`hooks.md`](./hooks.md) defines event-specific reducers. Those
reducers must be implemented before the engine depends only on a generic hook
dispatcher; otherwise extraction will silently change hook semantics.

### Subscriber failures currently affect runs

Notification listeners are awaited in registration order. A listener error is
normalized as a hook error and usually enters run failure reporting. This means
core notification subscribers are not fire-and-forget telemetry.

The server must not attach slow network writes directly to this awaited path.
It should copy envelopes into bounded client queues. The core ordering contract
can remain awaited per Session.

### Tool execution is already mostly stateless

`executeToolCalls()` receives context, one assistant message, execution mode,
abort signal, event sink, and hook emitter. It owns:

- tool lookup and argument preparation;
- schema validation;
- pre-call blocking hook;
- sequential/parallel scheduling;
- update events;
- post-result patch hook;
- tool-result message creation;
- terminate semantics.

It does not own a tool registry. Tool instances arrive in the turn snapshot.
This function can remain an internal stateless engine service.

Parallel execution currently prepares calls in assistant order, executes the
prepared calls concurrently, emits completion events in completion order, and
emits tool-result messages in assistant source order. Extraction must preserve
that ordering.

### Turn snapshot construction is Session-owned

`buildTurnState()` reads Session context and metadata, resolves active tools,
clones stream options, and invokes the system-prompt provider with the
`ExecutionEnv` and concrete `Session`.

Because it reads Session persistence and mutable Session config, snapshot
construction belongs to `AgentSession`. `AgentEngine` consumes snapshots but
does not construct them.

### Current failure semantics

Provider streams normally represent request failure or abort as a final
assistant message with `stopReason: "error"` or `"aborted"`; that message
follows the normal terminal path. Thrown hook, persistence, and loop errors are
caught by `TurnRunner.run()`, which creates a separate assistant failure message,
persists it, emits normal turn/agent terminal events, and resolves with messages
containing that failure artifact.

Only failure-reporting failure causes the runner to throw an aggregate
`AgentHarnessError`. As a result, current `send()` commonly resolves an
`AssistantMessage` even when the run failed.

A new `AgentRunOutcome` may classify that result as failed or aborted, but the
compatibility facade must continue returning the persisted failure message.

### Current abort semantics

`AgentHarness.abort()`:

- clears steer and follow-up queues;
- preserves the next-turn queue;
- aborts the current controller when one exists;
- waits for `runPromise`;
- emits `abort` after the run wait;
- aggregates queue-update, wait, and abort-listener errors.

The controller is currently created after snapshot construction and the
`before_agent_start` hook. An abort during dynamic system-prompt resolution or
that hook cannot interrupt the work; it only waits for completion. The target
`AgentSession` creates the controller synchronously when reserving a run. This
is an intentional lifecycle correction.

### Current idle timing contradicts the event contract comment

The event type comment says the harness becomes idle after awaited
`agent_end` listeners finish. The implementation calls `markIdle()` before
emitting `agent_end` and `settled`.

That early idle transition can allow reentrant `send()` to start another run
while the old run still owns `runPromise` and `runAbortController`. The target
design introduces an explicit `settling` state and does not allow a new run
until terminal listeners finish. This is an intentional behavior correction
that must be called out in release notes.

### Compaction and explicit retry are not integrated

The harness phase union includes `"compaction"` and `"retry"`, and compaction
helpers/events exist, but the current `AgentHarness` and `TurnRunner` do not
invoke the compaction pipeline. Provider retry options are forwarded to
`Models.streamSimple()`; the harness does not implement a separate retry loop or
retry phase.

Automatic compaction is a future engine capability at the save-point boundary,
not a capability that can currently be moved out of `TurnRunner`.

### Session storage is not safe for duplicate writable opens

`JsonlSessionStorage` loads entries and an ID map into memory. `appendEntry()`
appends a line and then updates that in-memory state. There is no process lock
or coordination between two storage instances opened on the same file.

`SessionHost` must guarantee one in-process runtime per Session and the Node
storage adapter must acquire a per-Session inter-process writer lease. This is
same-Session persistence integrity, not cross-Session workspace coordination.

### Resume currently trusts caller `cwd`

`AgentHarness.create()` creates `NodeExecutionEnv` from the caller's `cwd`
before opening the JSONL file. Opening an existing Session does not validate
that the caller's `cwd` matches the header's `cwd`.

The target host reads Session metadata first. The persisted `cwd` is
authoritative for resume; a conflicting override is rejected.

### Current server is single-Session

The server constructs one harness and one `session.jsonl`, broadcasts every
notification to every SSE client, treats a second prompt as steering depending
on phase, and has no Session identity in routes or events.

The server's `FileCredentialStore` serializes writes inside one process only.
It is explicitly not a cross-process credential lock.

The current harness has no public close/dispose method and does not call
`ExecutionEnv.cleanup()` or `cleanupSessionResources(sessionId)`. The local
`NodeExecutionEnv.cleanup()` is currently a no-op, but provider transports such
as cached OpenAI Codex WebSockets do own Session-scoped resources.

The server also constructs a separate `NodeExecutionEnv` for its default tools
instead of using the private environment created by `AgentHarness.create()`.
The target Session owns tool lifetime, but custom tools may still encapsulate
application-owned environments; the engine must not assume tool/environment
identity.

### Current core entrypoint is Node-coupled

`AgentHarness.create()` imports `node:crypto`, constructs `NodeExecutionEnv`, and
opens JSONL storage directly. The root package barrel also exports
`NodeExecutionEnv`. Despite platform-neutral intent in comments, the current
construction path is Node-specific.

The target keeps engine/run contracts platform-neutral and moves default Node
Session hosting behind a Node-specific export. Existing root exports remain as
compatibility aliases during migration.

### Current provider-response events expose raw headers

`TurnRunner` copies all provider response headers into
`after_provider_response`, and the current server broadcasts notification events
without a serialization/redaction boundary. The target server/CLI serializer
must redact authorization, cookie, and provider-sensitive headers before an
event leaves the process trust boundary.

## Shared `Models` Concurrency Audit

One `Models` collection is the primary shared dependency of `AgentEngine`.
Current implementation provides a reasonable concurrency base, with explicit
conditions.

### Verified facts

- `Models.streamSimple()` returns a fresh lazy `AssistantMessageEventStream` for
  every call.
- Auth is resolved per request before delegation to the provider.
- Request auth creates request-local model/options objects rather than mutating
  the configured model.
- OAuth refresh uses `CredentialStore.modify()` with double-checked expiry so
  concurrent requests share the refreshed credential when the store implements
  the contract correctly.
- Dynamic provider model refresh uses one in-flight refresh promise per
  provider created by `createProvider()`.
- Major provider adapters create request-local clients or request-local stream
  state. The Mistral adapter explicitly creates a per-request SDK client to
  avoid shared mutable client state.
- Faux-provider prompt cache state is keyed by `sessionId`.
- OpenAI Codex reusable WebSockets, debug state, and fallback state are keyed by
  `sessionId`. A busy cached connection causes another request to use a separate
  non-cached connection rather than sharing an active socket.
- `cleanupSessionResources(sessionId)` exists and currently closes cached
  OpenAI Codex WebSocket resources for that Session.

### Conditions and residual risks

- `MutableModels` allows provider set/delete/clear without a runtime lock.
  Provider registration must be treated as bootstrap-time configuration and
  frozen before concurrent runs begin.
- Provider factories are extensible. A custom provider may contain unsafe
  mutable request state even when built-in providers are safe. Concurrency is a
  provider contract and requires tests for custom providers.
- Some built-in modules contain process-level counters or caches. Audited state
  is either immutable, used only for unique IDs, or keyed by Session, but this
  is not a formal proof for future provider implementations.
- Credential safety depends on the concrete `CredentialStore`. The current
  server file store is single-process only.
- Session IDs must be stable and unique because providers use them for cache
  affinity and reusable transport resources.

### Selected policy

- Construct and configure one `Models` instance during application bootstrap.
- Do not mutate its provider registry after `SessionHost` starts accepting
  runs.
- Pass the same `Models` instance to the shared `AgentEngine`.
- Continue passing the durable `sessionId` on every provider request.
- Call `cleanupSessionResources(sessionId)` when an `AgentSession` is closed or
  evicted.
- Add concurrency contract tests using the faux provider and targeted tests for
  providers with Session-scoped caches.

## Goals

- One shared `AgentEngine` serves many Sessions concurrently.
- Mutable state never leaks between Sessions or runs.
- Existing within-Session transcript, event, hook, queue, tool, and save-point
  ordering is preserved unless this document marks a deliberate correction.
- A deterministic programmatic API exposes explicit run, steer, and abort
  operations.
- CLI one-shot and interactive modes use the same APIs as the server.
- Every external event is correlated with Session and run identity.
- Session create, select, resume, close, delete, and eviction are defined.
- Current version 4 linear Session history remains valid.
- Existing `AgentHarness` callers can migrate incrementally.

## Non-Goals

- Coordinating external resources across different Sessions.
- Preventing different Sessions with the same `cwd` from running concurrently.
- Session branches or tree navigation.
- Resuming an in-flight provider stream or tool call after process crash.
- Durable steering/follow-up queue recovery in the first implementation.
- Distributed execution across multiple hosts.
- Event replay for disconnected clients in the first server version.
- Sub-agent behavior, although sub-agents can later reuse this engine.
- Replacing provider auth, model discovery, or transport implementations.

## Final Ownership Model

| State or capability                             | Owner                                            |
| ----------------------------------------------- | ------------------------------------------------ |
| Provider/model collection                       | Shared dependency captured by the engine factory |
| Immutable engine policy                         | Shared dependency value                          |
| Optional engine-wide telemetry/limiter          | Injected shared service or wrapper               |
| Current context and turn snapshot               | one `AgentRun`                                   |
| Provider stream and partial assistant message   | one `AgentRun`                                   |
| Run input, pending messages, and outcome        | one `AgentRun`                                   |
| Session storage and writer                      | `AgentSession`                                   |
| Queues and queue modes                          | `AgentSession`                                   |
| Model/thinking/tools/resources/stream config    | `AgentSession`                                   |
| Tool instances and `ExecutionEnv`               | `AgentSession`                                   |
| Hook registrations and event sequence           | `AgentSession`                                   |
| Phase, current handle, and run control channel  | `AgentSession`                                   |
| Loaded Session map and eviction                 | `SessionHost`                                    |
| Node paths, Session discovery, and writer lease | Node host adapter                                |
| CLI formatting and exit codes                   | CLI adapter                                      |
| HTTP status and SSE buffering                   | server adapter                                   |

## AgentEngine Design

### Definition of stateless

`AgentEngine` is a capability interface, not necessarily a class. It is
stateless with respect to Sessions and runs. Its implementation may close over
shared infrastructure explicitly designed for concurrent use:

- `Models`;
- immutable execution policy;
- telemetry sinks;
- an optional engine-wide concurrency limiter.

It must not contain any implicit current-Session or current-run field.

The audited implementation does not reveal any shared behavioral storage that
requires a class. `Models` is an injected service reference with its own
provider/auth caches; it is not engine-owned Session state. Immutable policy is
plain data. Telemetry and an optional concurrency limiter can be injected
services or wrappers.

Therefore the selected public design uses an interface plus factory. A class is
permitted as a private implementation detail only if the engine later acquires
an actual lifecycle such as `dispose()`, a directly owned transport pool, or an
admission controller. Class identity, inheritance, and mutable fields are not
part of the contract.

Forbidden engine fields include:

```ts
private currentSession: Session;
private currentRun: AgentRun;
private activeTurnState: TurnSnapshot;
private queues: MessageQueues;
private events: AgentEventBus;
private abortController: AbortController;
```

### Engine capabilities

The engine owns:

- run input preparation, including user messages and next-turn injection;
- the `before_agent_start` hook call;
- agent/turn/message/tool lifecycle ordering;
- provider-context transformation;
- provider request/payload/response hooks;
- provider streaming and assistant-message assembly;
- sequential/parallel tool dispatch;
- steering and follow-up consumption points;
- save-point sequencing and snapshot refresh requests;
- failure-to-outcome conversion and persisted failure-message behavior;
- the future automatic-compaction decision point.

The engine does not own:

- Session discovery, storage implementation, or JSONL paths;
- Session config or snapshot construction;
- queue storage;
- hook registrations or Session event subscribers;
- tool factories or tool lifetime;
- abort-controller creation;
- phase, idle, close, or eviction;
- run-result serialization;
- CLI or HTTP policy.

### Shared engine capability and per-request run object

```ts
export interface AgentEngineDependencies {
  models: Pick<Models, "streamSimple" | "completeSimple">;
}

export interface AgentEngine {
  run<
    TSkill extends Skill,
    TPromptTemplate extends PromptTemplate,
    TTool extends AgentTool,
  >(
    input: AgentRunInput<TSkill, TPromptTemplate, TTool>,
    port: AgentRunPort<TSkill, TPromptTemplate, TTool>,
  ): Promise<AgentRunOutcome>;
}

export function createAgentEngine(
  dependencies: AgentEngineDependencies,
): AgentEngine {
  return {
    run: (input, port) => runAgent(dependencies, input, port),
  };
}
```

The internal pure entrypoint immediately creates a new `AgentRun` and returns
its promise:

```ts
function runAgent(
  dependencies: AgentEngineDependencies,
  input: AgentRunInput,
  port: AgentRunPort,
): Promise<AgentRunOutcome> {
  return new AgentRun({
    models: dependencies.models,
    input,
    port,
  }).execute();
}
```

Every mutable field currently held by `TurnRunner` stays on this new
short-lived object. Two calls through one `AgentEngine` capability never share
an `AgentRun`.
The initial extraction uses `streamSimple`; `completeSimple` is included in the
shared model-runtime capability for the later automatic-compaction phase.

The factory-created object exists only to bind dependencies once, provide a
stable injectable capability to `SessionHost`, and allow tests to replace it
with a fake. The equivalent lower-level form is valid:

```ts
runAgent(dependencies, input, port);
```

No correctness property depends on object identity.

### Run identity and snapshot

```ts
export interface AgentUserInput {
  text: string;
  images?: ImageContent[];
}

export interface AgentRunInput<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  sessionId: string;
  runId: string;
  input: AgentUserInput;
  initialSnapshot: TurnSnapshot<TSkill, TPromptTemplate, TTool>;
  control: AgentRunControlView;
}

export type InferenceInterruptReason = "steer";

export interface InferenceScope {
  signal: AbortSignal;
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
}

export interface TurnSnapshot<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  messages: AgentMessage[];
  resources: AgentHarnessResources<TSkill, TPromptTemplate>;
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  activeTools: TTool[];
  streamOptions: AgentHarnessStreamOptions;
}
```

`sessionId` is explicit run identity and provider affinity. It is not derived by
the engine. `runId` identifies one accepted execution and is never reused.

`AgentRunController` is created and owned by `AgentSession` for one run. It is
not shared between runs. The engine receives only its read-side
`AgentRunControlView`, so it cannot issue Session commands. `runSignal` cancels
the complete run. An inference scope creates a provider-call signal composed
from the run signal and a provider-only interrupt signal. The channel records
which signal caused cancellation so `AgentRun` can distinguish whole-run abort
from steering interruption.

The snapshot contains only data consumed by the run. The current `TurnState`
also contains all tools and its own `sessionId`; those fields can remain during
migration and be removed only after usage tests prove they are unnecessary.

### Run port

The Session supplies narrow capabilities rather than exposing the full
`AgentSession`, `Session`, queues, writer, or event bus.

```ts
export interface AgentRunPort<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  takeNextTurn(): Promise<AgentMessage[]>;
  drainSteering(): Promise<AgentMessage[]>;
  drainFollowUp(): Promise<AgentMessage[]>;

  commitMessage(message: AgentMessage): Promise<void>;
  hasPendingWrites(): boolean;
  flushPendingWrites(): Promise<void>;
  createTurnSnapshot(
    signal: AbortSignal,
  ): Promise<TurnSnapshot<TSkill, TPromptTemplate, TTool>>;

  emit(event: AgentEngineEvent, signal?: AbortSignal): Promise<void>;
  emitHook<TType extends keyof AgentHookEventResultMap>(
    event: Extract<AgentHookEvent, { type: TType }>,
    signal?: AbortSignal,
  ): Promise<AgentHookEventResultMap[TType] | undefined>;
}

export type AgentEngineEvent =
  AgentRunEvent | SavePointEvent | AfterProviderResponseEvent;
```

`takeNextTurn()` and queue drains are responsible for queue-update notification
and rollback semantics. This keeps queue mutation atomic inside `AgentSession`,
while the engine still decides when each queue is consumed.

`commitMessage()` persists before the engine emits `message_end`.

The engine implements save-point ordering using the primitive writer and event
ports. It does not assume JSONL storage:

```ts
let eventError: unknown;
try {
  await port.emit(turnEndEvent, input.control.runSignal);
} catch (error) {
  eventError = error;
}

const hadPendingMutations = port.hasPendingWrites();
await port.flushPendingWrites();
if (eventError) throw eventError;

await port.emit(
  { type: "save_point", hadPendingMutations },
  input.control.runSignal,
);
await port.flushPendingWrites();
snapshot = await port.createTurnSnapshot(input.control.runSignal);
```

This preserves current transcript and save-point semantics without importing a
concrete Session class into the engine.

### Hook port requirement

The final `emitHook()` implementation must use the event-specific reducer rules
from [`hooks.md`](./hooks.md). `AgentEngine` must not access a handler map or
call `getHandlers()`.

Required reducer parity includes:

- context transform chaining;
- before-agent message aggregation and system-prompt chaining;
- provider option patch chaining with field deletion;
- provider payload transform chaining;
- early tool-call blocking;
- tool-result patch accumulation;
- early Session-operation cancellation.

### Run outcome

The engine returns in-process errors, not serialized CLI/HTTP errors:

```ts
export type AgentRunOutcome =
  | {
      status: "completed";
      messages: AgentMessage[];
      finalMessage: AssistantMessage;
    }
  | {
      status: "aborted";
      messages: AgentMessage[];
      finalMessage: AssistantMessage;
    }
  | {
      status: "failed";
      messages: AgentMessage[];
      finalMessage?: AssistantMessage;
      error: Error;
    };
```

Provider error/abort messages remain transcript artifacts. `status` gives
headless adapters an unambiguous terminal classification. Safe serialization is
performed by the CLI/server boundary, where credentials and provider payloads
can be redacted.

Once a run has been accepted, `AgentRun` should normalize runtime failures into
an outcome. Failure to persist the failure artifact is also a failed outcome and
preserves both original and reporting errors as an aggregate cause.

### How concurrent Sessions use one engine

```ts
const runA = engine.run(inputA, portA);
const runB = engine.run(inputB, portB);

const [outcomeA, outcomeB] = await Promise.all([runA, runB]);
```

JavaScript promise concurrency allows both provider streams and tool promises
to progress. Correctness comes from object ownership:

- `inputA`, `portA`, and `AgentRun A` reference only Session A state;
- `inputB`, `portB`, and `AgentRun B` reference only Session B state;
- the shared engine has no current-run field;
- shared `Models` resolves and creates a separate stream per request;
- each run receives its own abort signal.

An optional engine-wide semaphore may limit capacity. Such a limiter is
operational shared state, not Session behavior state. It must be abortable while
waiting and must never select or mutate Session config.

## AgentSession Design

### Owned state

Each loaded `AgentSession` owns:

- `sessionId` and persisted metadata;
- `Session` and `SessionWriter`;
- `ExecutionEnv`;
- instantiated tool set and per-session `FileAccessTracker`;
- resources and system-prompt provider;
- model, thinking level, active tool names, and stream options;
- steering/follow-up modes;
- `MessageQueues`;
- hook dispatcher and event subscribers;
- event runtime ID and sequence;
- lifecycle state, current run handle, and per-run control channel;
- last-access information used by the host.

Tool instances are never shared between Sessions, including Sessions with the
same `cwd`.

### Lifecycle states

```ts
export type AgentSessionState =
  "idle" | "running" | "settling" | "closing" | "closed";
```

Structural operations require `idle`. Steering and abort require a compatible
active run. `settling` is not idle and rejects a new run.

### Public run API

```ts
export interface AgentRunResult {
  sessionId: string;
  runId: string;
  status: "completed" | "aborted" | "failed";
  messages: AgentMessage[];
  finalMessage?: AssistantMessage;
  error?: Error;
}

export interface AgentRunHandle {
  sessionId: string;
  runId: string;
  result: Promise<AgentRunResult>;
}

export interface AgentSteerOptions {
  interruptCurrentInference?: boolean;
}

export interface AgentSessionSnapshot {
  id: string;
  state: AgentSessionState;
  currentRunId?: string;
  model: ModelReference;
  thinkingLevel: ThinkingLevel;
}

export type AgentEventListener = (
  envelope: AgentEventEnvelope,
) => void | Promise<void>;

export interface AgentSession {
  readonly id: string;

  getSnapshot(): AgentSessionSnapshot;
  startRun(input: AgentUserInput): AgentRunHandle;
  steer(
    runId: string,
    input: AgentUserInput,
    options?: AgentSteerOptions,
  ): Promise<void>;
  abort(runId: string): Promise<AbortResult>;
  subscribe(listener: AgentEventListener): () => void;
}
```

`startRun()` is intentionally not async. It validates input and synchronously
reserves the Session before the first asynchronous operation:

```ts
startRun(input: AgentUserInput): AgentRunHandle {
   this.assertIdle();

   const runId = createRunId();
   const control = createAgentRunController();
   const result = createDeferred<AgentRunResult>();
   const handle = {
      sessionId: this.id,
      runId,
      result: result.promise,
   };

   this.state = "running";
   this.currentRun = { handle, control };

   void this.executeReservedRun(
      runId,
      input,
      control,
   ).then(
      result.resolve,
      (error) => result.resolve(this.toUnexpectedFailure(runId, error)),
   );

   return handle;
}
```

The deferred result lets the implementation publish the internal current-run
record before any code path can synchronously reenter the Session.

Creating the control channel at reservation time makes snapshot and
before-agent-start work abortable once those APIs accept `runSignal`.

### Run addressing and stale-command protection

Run lookup is deliberately two-level rather than global:

```text
sessionId -> SessionHost.loadedSessions -> AgentSession
runId     -> AgentSession.currentRun     -> AgentRunController
```

`SessionHost` uses `sessionId` to locate the loaded `AgentSession`. The Session
then compares the supplied `runId` with its single `currentRun.runId`. Because
the concurrency invariant permits only one active structural run per Session,
the Session does not need a `Map<runId, AgentRun>`.

Every command that can affect in-flight work carries both identities. The
public object call already selects the Session object, so its methods require
the remaining identity explicitly:

```ts
await session.steer(runId, input, options);
await session.abort(runId);
```

This is not redundant even with one active run. A delayed abort or steer from
run A may arrive after run A settled and run B started in the same Session.
Without the `runId` comparison, that stale command would incorrectly affect run
B. A missing, stale, or mismatched ID is an `invalid_state` error; the HTTP
adapter maps it to `409 Conflict` and must not fall back to the current run.

Engine-to-Session calls do not perform a lookup. When reserving the run,
`AgentSession` creates a port whose closure is permanently bound to both
identities:

```ts
private createRunPort(runId: string): AgentRunPort {
   const sessionId = this.id;

   return {
      commitMessage: async (message) => {
         this.assertCurrentRun(sessionId, runId);
         await this.session.appendMessage(message);
      },
      emit: async (event, signal) => {
         this.assertCurrentRun(sessionId, runId);
         await this.emitEnvelope({ sessionId, runId, event }, signal);
      },
      // The remaining port methods use the same identity guard.
   };
}
```

The corresponding `AgentRunInput`, `AgentRunPort`, controller, and outcome are
created together and never rebound. Consequently, concurrent AgentRuns from
Session A and Session B can call the same shared engine without their messages
being routed by engine-global mutable state.

Settlement uses the same defensive identity check before changing lifecycle
state or resolving the handle:

```ts
private assertCurrentRun(sessionId: string, runId: string): void {
   if (
      sessionId !== this.id ||
      this.currentRun?.handle.runId !== runId
   ) {
      throw new AgentHarnessError(
         "invalid_state",
         "Stale or mismatched AgentRun identity",
      );
   }
}
```

`executeReservedRun()` must call this guard before entering `settling`, before
clearing `currentRun`, and before resolving the run handle. Port mutation
methods also call it before touching Session-owned state. These checks are
defence in depth: the lifecycle barrier should already prevent a new run from
starting before the previous run fully settles.

A per-Session `Map<runId, AgentRunRecord>` is required only if a future design
allows multiple simultaneous structural runs inside one Session. That would
also require a new transcript ordering and conflict model and is outside this
design.

### Settlement

After `AgentEngine.run()` returns, `AgentSession`:

1. enters `settling`;
2. flushes remaining pending writes;
3. closes the run control channel and other run-scoped resources;
4. emits the existing `settled` compatibility notification;
5. emits the session-scoped terminal `run_settled` notification;
6. waits for terminal listeners;
7. clears the current run and enters `idle`;
8. resolves `AgentRunHandle.result`.

Starting another run from an awaited terminal listener is rejected while
settling. Callers that need chained work await the run result or use a future
`runWhenIdle()` facility. This avoids the current early-idle reentrancy race.

Errors from the existing pre-terminal compatibility events, including
`agent_end` and `settled`, are normalized before the final result is created.
The new `run_settled` envelope describes that already-final result; delivery
failure of a `run_settled` observer is reported through adapter diagnostics and
does not recursively change or re-emit the result. CLI output failures remain
CLI failures even though the agent run itself is already settled.

### Compatibility `send()`

The new API never converts `startRun()` into steering. The compatibility
`AgentHarness.send()` preserves current behavior:

```ts
const snapshot = session.getSnapshot();
if (snapshot.state === "idle") {
  return session.startRun(input).result.then(toLegacyAssistantResult);
}

const runId = snapshot.currentRunId;
if (!runId) {
  throw new AgentHarnessError("invalid_state", "Session has no active run");
}
return session.steer(runId, input);
```

Only the compatibility facade uses phase-dependent routing. Its snapshot read
does not weaken correctness: `steer()` atomically revalidates the captured
`runId`, so a settlement race cannot redirect the input into a newer run. The
facade's abort method resolves `currentRunId` in the same way before delegating.

### Snapshot factory

`AgentSession.createTurnSnapshot()` preserves current behavior:

- build model-visible context from persisted Session entries;
- copy resources and stream options;
- resolve active tools from the per-session registry;
- invoke the system-prompt provider;
- return concrete values used for one provider turn.

The snapshot is shallowly immutable by convention. Arrays and option maps are
copied so subsequent Session config mutation does not alter an in-flight
provider request.

### Bidirectional command and message flow

The Session and engine communicate through two separate directions. Neither
direction depends only on the final return value of `AgentEngine.run()`.

#### Session to active run

The Session owns command state. All commands first verify that the supplied
`runId` equals `currentRun.runId`:

- `steer(runId, input)` appends a user message to the Session's steering queue;
- `steer(runId, input, { interruptCurrentInference: true })` queues the same
  message and then requests provider-only interruption;
- `abort(runId)` clears steer/follow-up according to current semantics and calls
  `control.abortRun()`;
- next-turn input remains Session-owned and is consumed only at the beginning
  of a later user-initiated run.

Queue insertion, `queue_update`, and rollback complete before an inference
interrupt is requested. If queue notification fails and the insertion is rolled
back, the active inference is not interrupted.

Normal steering does not stop a provider or tool call. `AgentRun` observes it
only when it calls `port.drainSteering()` at a safe point.

For interrupting steering, the active `AgentRun` wraps each provider request in
an inference scope:

```ts
const inference = input.control.openInferenceScope();
try {
  const message = await streamAssistant({
    ...request,
    signal: inference.signal,
  });

  const interruptReason = inference.getInterruptReason();
  if (interruptReason === "steer" && !input.control.runSignal.aborted) {
    await finishInterruptedTurn(message);
    pendingMessages = await port.drainSteering();
    continue;
  }
} finally {
  inference.close();
}
```

If the provider returns a partial aborted assistant message, that message is
committed so the durable transcript matches output already shown to the user.
The run then emits `turn_end`, reaches a save point, drains the steering message,
persists that user message, and continues with a fresh provider turn.

If a provider does not produce a final aborted message, the run creates the same
kind of aborted assistant artifact used by current failure reporting before it
continues.

`interruptInference()` affects only an active provider request. It does not
cancel a tool already executing. If no inference scope is active, it returns
`false`; the steering message remains queued for the next safe point. Whole-run
`abortRun()` cancels provider and tool work through `runSignal` and never
continues the run.

This separation prevents a steering interrupt from being mistaken for a
terminal user abort.

#### Active run to Session

The engine returns information incrementally through `AgentRunPort`:

1. The run-bound `port.emit(message_start/message_update)` streams progress to
   the originating Session's event bus without persisting partial snapshots.
2. When a user, assistant, or tool-result message is complete,
   `port.commitMessage(message)` appends it to the Session.
3. Only after commit succeeds does the engine emit `message_end`.
4. At turn boundaries the engine asks the Session to flush pending writes and
   build the next snapshot.
5. At run completion `AgentRunOutcome` returns the aggregate messages and
   terminal classification to `AgentSession`.
6. `AgentSession` performs settlement, emits `run_settled`, and resolves the
   caller's `AgentRunHandle.result`.

The final outcome is therefore a summary of an already incrementally committed
run. It is not the mechanism used to return every message to the Session. No
engine-global run registry participates in either direction.

## SessionHost Design

`SessionHost` owns application-level Session lifecycle. It does not execute the
agent loop.

```ts
export interface CreateSessionOptions {
  cwd: string;
  model: ModelReference;
  thinkingLevel?: ThinkingLevel;
}

export interface ModelReference {
  providerId: string;
  modelId: string;
}

export interface SessionSummary {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  loadedState: "unloaded" | AgentSessionState;
  model?: ModelReference;
  thinkingLevel?: ThinkingLevel;
}

export interface SessionHost {
  create(options: CreateSessionOptions): Promise<AgentSession>;
  open(sessionId: string): Promise<AgentSession>;
  list(): Promise<SessionSummary[]>;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  shutdown(options?: { abortRunning?: boolean }): Promise<void>;
}
```

### Loaded map and single-flight open

- Opening an already loaded Session returns the same `AgentSession` object.
- Concurrent opens of one unloaded Session share one initialization promise.
- A failed initialization removes its in-flight entry so a later call can
  retry.
- The engine is injected into every Session; the host does not create an engine
  per Session.

### Same-Session writer lease

The Node adapter acquires a per-Session process lease before opening writable
storage. Another process receives a typed `session_locked` error. The lease is
released on close, eviction, or clean shutdown.

This lease protects one Session JSONL file from duplicate writers. It does not
lock `cwd` and does not coordinate different Sessions.

The precise cross-platform lease implementation requires its own implementation
note. The invariant is mandatory even if the first backend is local-only.

### Default durable layout

```text
<dataDir>/
  sessions/
    <sessionId>/
      session.jsonl
      runtime.lock
```

The Session ID is an opaque stable UUID and must match the JSONL header. Session
discovery scans directories and reads validated headers. `updatedAt` can be
derived from the JSONL file until a rebuildable catalog is needed.

### Open and resume

The host reads the JSONL header before constructing `ExecutionEnv`. Header
`cwd` is authoritative. A caller-supplied conflicting path is rejected.

Open then:

1. acquires the Session writer lease;
2. opens and validates JSONL storage;
3. resolves persisted runtime config;
4. validates the model and active tools against current application resources;
5. creates the per-session environment and tool instances;
6. creates hooks/event runtime and `AgentSession`;
7. publishes the loaded instance in the host map.

### Close and eviction

Normal close is idle-only. It:

1. flushes pending writes;
2. disposes Session hooks/subscriptions owned by the host;
3. calls `ExecutionEnv.cleanup()`;
4. calls `cleanupSessionResources(sessionId)`;
5. releases the writer lease;
6. removes the loaded instance.

Automatic eviction is optional initially. An idle Session is eligible only
when it has no pending writes, active run, pinned subscriber, or other declared
lifecycle resource. Eviction uses the same close path.

Delete requires an idle, exclusively leased Session and removes only the
Session directory. It never deletes the Session's working directory.

## Runtime Configuration Persistence

Current model and thinking changes are memory-only. CLI resume requires durable
selection, so persistence is a separate feature after engine extraction.

The selected backward-compatible version 4 representation is a reserved custom
entry:

```text
loopiq.session_config.v1
```

```ts
export interface PersistedSessionConfigV1 {
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  activeToolNames: string[];
}
```

Creation appends a complete initial snapshot. Later changes append complete
replacement snapshots, not partial patches. Resume scans physical order and
uses the last valid entry. The custom entry is excluded from model context and
does not alter linear Session ordering.

System-prompt providers, concrete tools, resources, credentials, and transports
remain application-owned and are reconstructed during open. Missing persisted
models or tools produce an explicit resume error unless the caller supplies a
documented override.

CLI `--model` and `--thinking` overrides are validated and persisted before the
run starts.

## Event and Hook Contract

### External envelope

Every notification leaving `AgentSession` is wrapped:

```ts
export interface AgentEventEnvelope {
  schemaVersion: 1;
  sessionId: string;
  runtimeId: string;
  runId?: string;
  sequence: number;
  timestamp: string;
  event: AgentNotificationEvent | RunSettledEvent;
}
```

- `runtimeId` identifies one loaded `AgentSession` lifetime.
- `sequence` increases within that runtime lifetime and may reset after reopen.
- run events include `runId`.
- Session config/lifecycle events may omit `runId`.
- no ordering is promised across Sessions.
- event payloads must redact authorization headers and credentials.

### Terminal notification

```ts
export interface RunSettledEvent {
  type: "run_settled";
  status: "completed" | "aborted" | "failed";
  error?: SerializedRunError;
}

export interface SerializedRunError {
  code: string;
  message: string;
}
```

`agent_end` remains an engine-loop event. `run_settled` is the headless terminal
contract after persistence and cleanup attempts have settled. A persistence
failure changes the terminal status to failed. Because this event describes a
final result, observer-delivery errors are reported separately and cannot
rewrite its status.

### Hook ownership

Hook registrations are per Session by default. Shared application extensions
may register equivalent handlers into each Session, but handlers must receive
explicit context and must not depend on a global current Session.

The engine calls only the typed hook dispatcher. Reducer policy, cleanup,
source metadata, and error policy belong to the hook implementation described in
[`hooks.md`](./hooks.md).

## CLI and Headless Entrypoint

### Package and direct execution

Add a dedicated `@loopiq/cli` package:

```json
{
  "bin": {
    "loopiq": "./dist/cli.js"
  }
}
```

The CLI invokes `SessionHost` and `AgentSession` directly. It does not require a
running server. Node-specific host construction should be exposed from a
Node-specific package subpath; the existing root Node exports remain temporarily
for compatibility.

### Commands

```text
loopiq run [prompt] [options]
loopiq chat [options]
loopiq sessions list [options]
loopiq sessions create [options]
loopiq sessions delete <sessionId> [options]
```

Important run options:

```text
--session <sessionId>       Resume an existing Session
--new                       Create a new Session
--cwd <path>                Working directory for a new Session
--model <provider/model>    Validate and persist model selection
--thinking <level>          Validate and persist thinking level
--format <text|json|jsonl>  Output format; default is text
--stdin                     Read prompt from standard input
```

`--session` and `--new` are mutually exclusive. Prompt argument and `--stdin`
are mutually exclusive. Resume does not permit a different `cwd`.

### One-shot lifecycle

1. parse flags without initializing providers;
2. initialize credentials, frozen `Models`, engine, and host;
3. create or open the Session;
4. attach the selected renderer;
5. apply explicit persisted config overrides;
6. call `startRun()`;
7. await the run handle;
8. close the Session and shut down the host;
9. map the result to output and an exit code.

### Output

`text`:

- assistant text deltas on stdout;
- diagnostics and progress on stderr;
- ANSI only when stdout is a TTY;
- hidden thinking omitted by default.

`json`:

- no streamed stdout;
- exactly one safe serialized run result on stdout;
- diagnostics on stderr.

`jsonl`:

- one `AgentEventEnvelope` per stdout line;
- exactly one final `run_settled` line for an accepted run;
- no human logs on stdout.

### Exit codes

```text
0    Run completed
1    Accepted run failed
2    Usage or flag error
3    Configuration, authentication, or model resolution error
4    Session missing, invalid, busy, or locked
130  Run aborted by SIGINT
```

The first SIGINT aborts the current Session run and waits for settlement. A
second SIGINT may force exit with a warning that cleanup may be incomplete.

Interactive mode lands after one-shot mode. Input received while running is not
silently steering; steering must be an explicit interactive action.

## Multi-Session Server

The target routes are:

```text
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:sessionId
DELETE /api/sessions/:sessionId

POST   /api/sessions/:sessionId/runs
POST   /api/sessions/:sessionId/runs/:runId/steer
POST   /api/sessions/:sessionId/runs/:runId/abort
GET    /api/sessions/:sessionId/events
```

`POST /runs` returns `202` with `sessionId` and `runId`. Busy is `409`, missing
is `404`, and locked is `423`. A steer or abort whose `runId` does not equal the
Session's active run returns `409`; adapters must never reinterpret it as a
command for whichever run is current.

Each SSE endpoint sees only its Session's envelopes. The server copies awaited
core notifications into bounded per-client buffers; a slow or disconnected
client cannot stall an agent run.

Legacy `/api/prompt`, `/api/abort`, and `/api/events` may temporarily route to a
configured default Session and continue emitting naked events for the current
DevUI.

## Compatibility and Deliberate Breaks

| Area                     | Current behavior                           | Target behavior                                            | Migration                            |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------ |
| `AgentHarness.create()`  | Builds Node env and one Session            | Compatibility facade over one engine/session               | Preserve initially                   |
| `send()`                 | Idle starts, any busy phase steers         | Explicit `startRun()` and `steer()`                        | Preserve `send()` only on facade     |
| Run result               | Usually resolves failure assistant message | Typed completed/aborted/failed result                      | Facade maps back to legacy message   |
| Events                   | Naked event                                | Session/run envelope                                       | Facade and legacy SSE strip envelope |
| Idle timing              | Idle before `agent_end` listeners finish   | `settling` until terminal listeners finish                 | Deliberate lifecycle fix             |
| Abort setup              | Controller created after initial hooks     | Run control channel created during synchronous reservation | Deliberate lifecycle fix             |
| Steering interruption    | Steering waits for a safe point            | Optional provider-only interruption then continue          | Additive explicit option             |
| Model/thinking resume    | Memory-only                                | Persisted config snapshot                                  | Separate feature phase               |
| Hooks                    | Mixed last-result/manual reducers          | Typed event-specific reducers                              | Parity tests before switch           |
| Compaction               | Helpers only, not loop-integrated          | Engine save-point integration later                        | Separate feature phase               |
| Provider registry        | Mutable at runtime                         | Frozen after host startup                                  | Bootstrap policy                     |
| Session writer ownership | No duplicate-open protection               | Host single-flight and process lease                       | New invariant                        |

No Session v4 message or compaction entry is rewritten by engine extraction.

## Migration Architecture

### Compatibility facade

During migration:

```text
AgentHarness
  -> one AgentSession
  -> shared-or-private AgentEngine
```

The facade retains current construction and public methods. New server/CLI code
uses `SessionHost` and explicit Session methods.

### Proposed module layout

```text
packages/agent-harness/src/
  engine/
    agent-engine.ts
    agent-run.ts
    agent-run-port.ts
    agent-run-outcome.ts
  runtime/
    agent-session.ts
    session-host.ts
    event-envelope.ts
    persisted-session-config.ts
  core/
    tool-execution.ts
    stream-options.ts
    message-factory.ts
  session/
    session.ts
    session-writer.ts
    jsonl-storage.ts
  node/
    node-session-host.ts
    node-session-lease.ts

packages/cli/src/
  cli.ts
  commands/
  output/
```

`TurnRunner` is replaced by internal `AgentRun`. `buildTurnState()` moves under
Session snapshot construction. Pure helpers remain reusable engine internals.

## Implementation Order

### Phase 0: Characterize current behavior

- Add faux-provider fixtures.
- Test exact event and persistence ordering.
- Test success, provider error, hook error, and failure-reporting error.
- Test steering/follow-up/next-turn drains and rollback.
- Test current abort timing and queue clearing.
- Test save-point snapshot refresh and dynamic system-prompt calls.
- Record current early-idle behavior in a test marked for deliberate change.

### Phase 1: Complete hook reducers

- Implement the typed hook dispatcher from `hooks.md`.
- Move provider request and payload chaining out of `TurnRunner`.
- Prove parity for every current hook reducer.
- Keep the current `AgentHarness` public surface.

### Phase 2: Extract `AgentRunPort` and shared engine capability

- Let the existing `AgentHarness` implement the port.
- Move `executeTurn()` and `TurnRunner` run behavior behind the `AgentEngine`
  interface/factory plus a per-call `AgentRun`.
- Remove concrete `Session`, writer, queues, event bus, and `markIdle()` from
  engine dependencies.
- Keep one harness/one Session so behavior can be compared directly.
- Add two-port concurrent engine tests.

### Phase 3: Extract `AgentSession`

- Move config, queues, persistence, hooks, phase, abort, and snapshot factory
  out of the compatibility facade.
- Add synchronous run reservation and `settling`.
- Add per-run control channel with separate run abort and provider-inference
  interruption.
- Add run IDs, outcomes, and envelope generation.
- Preserve legacy `AgentHarness` mappings.

### Phase 4: Add `SessionHost`

- Add loaded map, single-flight open, create/list/close/delete.
- Add metadata-first resume and `cwd` validation.
- Add process writer lease.
- Add Session resource cleanup and optional idle eviction.
- Add per-session tool factories.

### Phase 5: Add durable runtime config

- Add the reserved custom entry and reducer.
- Persist model/thinking/active-tool snapshots.
- Validate restore against current models/tools.
- Keep this separate from engine extraction tests.

### Phase 6: Migrate server

- Construct one frozen `Models`, engine, and host.
- Add Session-scoped routes and SSE.
- Add bounded client queues.
- Keep temporary default-Session compatibility routes.

### Phase 7: Add CLI

- Implement one-shot run and three output modes.
- Add Session management commands.
- Add signal handling and deterministic exit codes.
- Add interactive mode only after one-shot contracts stabilize.

### Phase 8: Integrate automatic compaction

- Add compaction decision and execution at engine save points.
- Keep compaction persistence through Session ports.
- Test abort, hook override, failure, and repeated compaction.

## Test Requirements

### Engine isolation

- two Sessions interleave provider deltas without context bleed;
- one Session's model/thinking/tools never appear in another request;
- events go only through the corresponding port;
- aborting one run does not abort another;
- run-local partial messages and snapshots are distinct objects;
- engine fields contain no Session/run mutable state;
- optional limiter does not change Session selection or ordering.

### Session behavior

- synchronous busy reservation prevents two runs in one Session;
- stale steer from a settled run does not affect a newer run;
- stale abort from a settled run does not terminate a newer run;
- mismatched run identity cannot settle or clear the current run;
- two Sessions running concurrently commit and emit only through their bound
  ports;
- settling rejects reentrant structural operations;
- message persistence precedes `message_end` notification;
- turn listener errors still flush pending writes;
- queue drains roll back on notification failure;
- next-turn survives abort;
- normal steering waits for the next safe point without cancelling inference;
- interrupting steering commits the partial aborted assistant message, drains
  the queued instruction, and continues the same run;
- inference interruption during tool execution returns false and leaves the
  message queued;
- whole-run abort wins an abort/steer-interrupt race and never continues;
- dynamic config changes affect only future snapshots;
- close flushes and cleans Session-scoped provider resources.

### Provider sharing

- concurrent faux streams use distinct contexts and stable Session IDs;
- one OAuth refresh serves concurrent expired-token requests;
- provider registry mutation after startup is rejected by application policy;
- Session-scoped provider caches are cleaned on close;
- custom provider concurrency contract is documented and testable.

### Storage and host

- concurrent open of one Session returns one runtime;
- second-process writer lease acquisition fails cleanly;
- open failure can be retried;
- header `cwd` controls resume;
- idle close/reopen reconstructs context and config;
- eviction never selects running or settling Sessions.

### CLI

- prompt argument and stdin;
- create and resume;
- exact stdout/stderr separation;
- one JSON result;
- one terminal JSONL event;
- provider/config/session failure exit codes;
- SIGINT abort and flush;
- no server dependency.

### Server

- simultaneous runs in different Sessions;
- busy conflict in one Session;
- Session-scoped SSE filtering;
- slow/disconnected SSE client does not block core execution;
- close/reopen and optional eviction;
- compatibility routes remain behaviorally stable until removed.

## Observability

Engine metrics:

- active and queued runs;
- completed, aborted, and failed outcomes;
- provider request count/latency;
- tool call count/latency;
- compaction count/latency after integration.

Host metrics:

- loaded, running, and settling Sessions;
- open/close/eviction count;
- writer-lease contention;
- load and close latency.

Every Session log includes `sessionId` and `runtimeId`; run logs also include
`runId`. Metrics must not use raw prompts, `cwd`, credentials, or unbounded
error messages as labels.

## Rejected Alternatives

### One `AgentHarness` per Session as the final design

This permits concurrent calls but duplicates engine assembly, retains ambiguous
`send()` behavior, and does not create a reusable run kernel.

### A shared `TurnRunner` singleton

`TurnRunner` contains mutable active snapshot and context. Sharing one instance
would directly mix concurrent runs. The shared object is `AgentEngine`; every
request receives a new `AgentRun`.

### Engine owns the Session map

This makes the engine stateful and mixes execution behavior with discovery,
eviction, and storage policy. `SessionHost` owns the map.

### Engine receives the full `AgentSession`

This permits accidental retention and mutation of unrelated Session state. The
engine receives only immutable run input and a narrow `AgentRunPort`.

### Persistence as an event subscriber

This loses the committed-state event contract and changes failure ordering.
Persistence is an explicit port invoked before `message_end` notification.

### CLI requires the server

This prevents standalone CI/headless use and makes process exit dependent on
network/SSE behavior. Remote CLI mode can be added separately.

### Workspace locking in this design

Cross-Session external-resource conflicts are a separate future subsystem.
This design includes only same-Session durable-writer exclusion.

## Final Review Decisions

1. Share one Session-stateless `AgentEngine` capability created by a factory;
   do not require a public class.
2. Create one mutable `AgentRun` for each accepted request.
3. Pass Session behavior through `AgentRunPort`; never pass a full Session to
   the engine.
4. Keep one active structural operation per Session and allow different
   Sessions to run concurrently, including the same `cwd`.
5. Share a frozen `Models` instance and clean provider resources by Session ID.
6. Keep queues, hooks, tools, persistence, config, abort, and lifecycle on
   `AgentSession`.
7. Keep discovery, same-Session writer exclusion, and eviction on
   `SessionHost`.
8. Preserve current transcript/save-point/tool/hook ordering through explicit
   characterization tests.
9. Deliberately replace early idle with a `settling` barrier.
10. Keep `AgentHarness` and naked events as temporary compatibility facades.
11. Implement runtime config persistence after engine extraction, using a
    reserved version 4 custom entry.
12. Implement automatic compaction after the core multi-Session path is stable.
13. Deliver one-shot CLI before interactive CLI.
14. Use a per-run control channel to distinguish queued steering,
    provider-only inference interruption, and whole-run abort.
15. Route commands by `sessionId` plus `runId`, bind engine callbacks to a
    run-specific port, and reject stale run identities instead of targeting the
    Session's current run implicitly.

Further evolution should preserve these ownership, concurrency, lifecycle, and
compatibility decisions unless this document is revised with the code.
