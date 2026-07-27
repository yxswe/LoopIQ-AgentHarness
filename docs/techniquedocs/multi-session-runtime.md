# Multi-Session Runtime Design

Status: Implemented behavior

Last audited: 2026-07-27

This document defines current multi-Session ownership, concurrency, hosting, and
adapter contracts. `Agent` is the sole application entry; concrete hosts,
Sessions, engines, and run ports are internal and addressed through explicit
Session and run identities.

## Runtime Structure

```text
CLI / Server adapters
        |
        v
  Agent facade
   |             |
   v             v
ModelRuntime  AgentSessionManager
   |          |             |
   |          v             v
   |      AgentSession A  AgentSession B
   |          |             |
   |          +------+------+
   |                 v
   +----------> AgentEngine
                 |     |
                 v     v
             AgentRun A AgentRun B
```

The concurrency contract is:

- one active structural operation per `AgentSession`;
- concurrent operations across different Sessions;
- one writable runtime per durable Session store;
- no coordination of files, shell processes, or other external resources
  across different Sessions.

Different Sessions may use the same `workspaceDir` and still run concurrently.

## Ownership

| State or capability | Owner |
| --- | --- |
| Adapter-facing command surface | Thin `Agent` facade |
| Subsystem construction and dependency wiring | `createAgent()` |
| Session/run identity routing and shutdown | `AgentSessionManager` |
| Supported provider registry, credential operations, mutation exclusion, switchable-model policy, and model catalog | `ModelRuntime` |
| Loaded default provider/model pair, thinking level, and safe request policy | `AgentSettings` |
| Persisted Agent settings | `FileAgentSettingsStore` (`agent.json`) |
| Persisted provider credentials | `FileCredentialStore` (`credentials.json`) |
| Online credential-validation cache | `ModelRuntime` memory |
| Model lookup/streaming, System Prompt, Skills, Prompt Templates, and tool factory | `AgentEngine` |
| Loaded model-visible message context | `AgentSession` memory |
| Stable current-Turn snapshot | One `AgentRun` |
| Provider stream and partial assistant message | One `AgentRun` |
| Run input, pending messages, and outcome | One `AgentRun` |
| Session Store and pending configuration snapshot | `AgentSession` |
| Steering queue and one-at-a-time drain policy | `AgentSession` |
| Session model/thinking selection | `AgentSession` |
| Tool instances and `ExecutionEnv` | `AgentSession` |
| Notification subscribers and event sequence | `AgentSession` |
| Lifecycle state and run control channel | `AgentSession` |
| Loaded Session map, discovery, file paths, environment, and writer lease | `AgentSessionManager` |
| CLI formatting and exit codes | CLI adapter |
| HTTP policy and SSE buffering | Server adapter |

## Agent

`Agent` is a thin facade and the only surface imported by Server and CLI
adapters:

```ts
export interface Agent {
  createSession(options): Promise<SessionSnapshot>;
  getSession(sessionId): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionSummary[]>;
  updateSession(sessionId, options): Promise<SessionSnapshot>;
  closeSession(sessionId): Promise<void>;
  deleteSession(sessionId): Promise<void>;
  run(sessionId, input): Promise<RunHandle>;
  steer(sessionId, runId, input, options?): Promise<void>;
  abort(sessionId, runId): Promise<AbortResult>;
  subscribe(sessionId, listener): Promise<() => void>;
  listProviders(options?): Promise<ProviderSummary[]>;
  listModels(providerId?, options?): Promise<ModelSummary[]>;
  getProviderStatus(providerId): Promise<ProviderStatus>;
  addProviderCredential(providerId, options): Promise<ProviderStatus>;
  validateProviderCredential(providerId): Promise<ProviderStatus>;
  removeProviderCredential(providerId): Promise<void>;
  getConfiguration(): Promise<AgentConfiguration>;
  updateConfiguration(update): Promise<AgentConfiguration>;
  shutdown(options?): Promise<void>;
}
```

Every facade method performs one delegation to `AgentSessionManager`,
`ModelRuntime`, or `AgentSettings`; it does not implement cross-owner workflows.
`createAgent()` is the separate composition root. It asynchronously initializes
local settings and stores in the single per-user Agent Home (`~/.loopiq`),
registers the eleven supported providers, creates one `AgentEngine` and one
`AgentSessionManager`, wires narrow model and configuration capabilities, and
returns the facade. Creation does not log in, validate credentials, refresh
OAuth, or access a provider. The Agent returns serializable summaries,
snapshots, and handles rather than concrete provider, engine, or Session
objects.

## Internal AgentEngine

`AgentEngine` is Session-stateless. It retains shared application execution
assets: model lookup/streaming, System Prompt policy, Skills and Prompt
Templates, the Session tool factory, and Provider request policy. It must not
retain a current Session, run, message context, steering queue, Store, or abort
controller.

```ts
export class AgentEngine {
  resolveModel(reference: ModelReference): Model;
  createSessionTools(env: ExecutionEnv): Promise<AgentTool[]>;
  createTurnSnapshot(input: {
    sessionId: string;
    env: ExecutionEnv;
    model: Model;
    thinkingLevel: ThinkingLevel;
    tools: AgentTool[];
  }): Promise<TurnState>;
  cleanupSession(sessionId: string): void;
  run(input: AgentRunInput, port: AgentRunPort): Promise<AgentRunOutcome>;
}
```

Every call creates a fresh `AgentRun`. Correct isolation comes from object
ownership rather than a global scheduler.

## Internal AgentRunPort

The Session supplies narrow capabilities instead of exposing itself:

```ts
export interface AgentRunPort {
  drainSteering(): Promise<AgentMessage[]>;
  commitMessage(message: AgentMessage): Promise<void>;
  flushPendingSessionState(): Promise<boolean>;
  createTurnSnapshot(): Promise<TurnState>;
  emit(event: AgentEngineEvent): Promise<void>;
}
```

The steering drain owns update notification and rollback behavior.
`commitMessage()` appends through `JsonlSessionStore`, then adds the message to
the loaded context, and only then permits `message_end`. Save-point ordering is
owned by the run. Session state remains Session-owned, while the Engine owns
snapshot assembly.

The concrete port closure is permanently bound to one run ID and validates that
identity before Session access.

## Internal AgentSession

Each loaded Session owns:

- durable Session identity and metadata;
- `JsonlSessionStore`, `ExecutionEnv`, and the loaded message array;
- instantiated tools;
- model, thinking level, and pending persisted configuration;
- one steering queue with a fixed one-at-a-time drain policy;
- notification subscribers, runtime ID, and event sequence;
- lifecycle state, current handle, and run controller.

Lifecycle states are:

```text
idle -> running -> settling -> idle
idle -> closing -> closed
```

`startRun()` reserves synchronously. `steer(runId, ...)` and `abort(runId)`
require the exact active run ID. A stale command cannot target a newer run.

## Command and Result Flow

Agent commands are routed by `sessionId` and `runId` to an internal Session.
The Agent accepts a Run without inspecting or reserving the Session Provider's
credential. `@loopiq/ai` resolves current authentication when each Provider
request starts, so credential replacement or removal may proceed while a Run is
active and is observed naturally at a request boundary. Session-to-run commands
use two channels:

- `SteeringQueue` carries user redirection to the next safe point;
- `AgentRunController` carries whole-run abort and provider-only interruption.

Run-to-Session information is incremental:

1. progress events stream through the run-bound port;
2. complete messages are committed immediately;
3. `message_end` follows successful commit;
4. turn boundaries flush pending configuration and refresh Engine-owned
   execution state without copying the Run's complete message context;
5. `AgentRunOutcome` summarizes already-committed work;
6. `AgentSession` emits `run_settled` and resolves the handle.

The final outcome is not a transaction that writes all run messages at once.

## Internal AgentSessionManager

`AgentSessionManager` implements the Agent's durable Session lifecycle and all
Session-facing application commands:

```ts
export class AgentSessionManager {
  createSession(options: CreateSessionOptions): Promise<SessionSnapshot>;
  getSession(sessionId: string): Promise<SessionSnapshot>;
  listSessions(): Promise<SessionSummary[]>;
  updateSession(sessionId: string, options: UpdateSessionOptions): Promise<SessionSnapshot>;
  run(sessionId: string, input: AgentInput): Promise<RunHandle>;
  steer(sessionId: string, runId: string, input: AgentInput, options?: SteerOptions): Promise<void>;
  abort(sessionId: string, runId: string): Promise<AbortResult>;
  subscribe(sessionId: string, listener: AgentEventListener): Promise<() => void>;
  create(options: CreateSessionOptions): Promise<AgentSession>;
  open(sessionId: string): Promise<AgentSession>;
  list(): Promise<SessionSummary[]>;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  shutdown(options?: { abortRunning?: boolean }): Promise<void>;
}
```

`createAgent()` constructs exactly one internal `AgentEngine` and passes it to
the manager. The manager shares that Engine across loaded Sessions but does not
configure prompts, resources, tools, models, or Provider policy. It receives one
narrow `resolveSwitchableModel()` capability from `ModelRuntime`; Provider
credential validation and model-catalog rules remain model-owned.

Opening an already loaded Session returns the same `AgentSession`. Concurrent
opens of one unloaded Session share one initialization promise. Failed
initialization removes its in-flight entry so a later call can retry.
Closing a running Session is rejected without removing it from the loaded map or
releasing its writer lease.

The default layout is:

```text
~/.loopiq/
  agent.json
  credentials.json
  sessions/
    <sessionId>/
      session.jsonl
      runtime.lock
```

The JSONL header's normalized absolute `workspaceDir` is authoritative on
resume. Creation and resume reject a missing or non-directory Workspace. The
manager maps that path to `NodeExecutionEnv.cwd`, reconstructs the Store, then
`AgentSession.load()` asks the Engine for model resolution and tool creation and
restores the in-memory message context once before publishing the loaded
instance. Agent Home contains Agent-owned state; it is never used as the
Session's Workspace implicitly.

## Writer Lease

`AgentSessionManager` acquires a per-Session process lease before writable open.
Another process receives `AgentRuntimeError("session_locked")`. The lease is
released on close, failed initialization, delete, or shutdown.

The lease protects one Session JSONL file from duplicate writers. It does not
lock the Session's working directory.

The concrete shared-`workspaceDir` mutation race, current optimistic safeguards,
and the non-implemented process-wide coordination direction are maintained in
[`engineering-challenges.md`](./engineering-challenges.md#ec-001-concurrent-file-mutation-across-sessions).

## Runtime Configuration Persistence

Model and thinking level are stored as complete replacement snapshots in
explicit `session_config` entries.

Resume scans physical entry order and uses the latest valid snapshot. Runtime
configuration entries are excluded from model context.

The global default model, default thinking level, and safe Provider request
policy live in `agent.json`. The model may reference a registered Provider
without a credential. Default model and thinking level affect only new Sessions;
existing Sessions retain their persisted values. Provider request policy is
read for every turn snapshot and therefore affects all Sessions on their next
Provider request without changing an in-flight request. Headers and metadata
are not part of the Agent runtime configuration API.

Changing an existing Session's provider/model is one atomic
`Agent.updateSession()` operation. It requires a persisted credential that
passes current online validation and a model belonging to that provider's
catalog. Removing a credential does not unregister the provider, change the
default, or rewrite Session history; future runs using it fail authentication.

## Event Contract

Every Session notification is wrapped:

```ts
export interface AgentEventEnvelope {
  sessionId: string;
  runtimeId: string;
  runId?: string;
  sequence: number;
  timestamp: string;
  event: AgentNotificationEvent | RunSettledEvent;
}
```

`runtimeId` identifies one loaded lifetime. Sequence increases within that
lifetime and may reset after reopen. No ordering is promised across Sessions.

`run_settled` is the terminal contract for an accepted run. Its observer cannot
rewrite the result it describes. Adapters redact sensitive payloads before
events leave the process boundary.

## Server API

The server translates HTTP routes directly to Agent methods:

```text
GET    /api/runtime
GET    /api/configuration
PATCH  /api/configuration
GET    /api/providers
GET    /api/providers/:providerId/models
POST   /api/providers/:providerId/credential
DELETE /api/providers/:providerId/credential
GET    /api/provider-credential-jobs/:jobId/events
POST   /api/provider-credential-jobs/:jobId/respond
DELETE /api/provider-credential-jobs/:jobId
POST   /api/sessions
GET    /api/sessions
GET    /api/sessions/:sessionId
PATCH  /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
POST   /api/sessions/:sessionId/runs
POST   /api/sessions/:sessionId/runs/:runId/steer
POST   /api/sessions/:sessionId/runs/:runId/abort
GET    /api/sessions/:sessionId/events
```

`/api/runtime` returns the model and browser-selected Session ID for DevUI
bootstrap. It does not execute, steer, or abort work implicitly.

## CLI Contract

The CLI invokes `Agent` directly and does not require a server. It exposes
Session commands, provider list/add/remove, model listing, and Agent default
configuration. Text, JSON, and JSONL modes keep authentication diagnostics off
machine-readable stdout. Terminal secret prompts disable input echo. SIGINT
calls `Agent.abort(sessionId, runId)` and waits for settlement.

## Current Limitations

- Context compaction is not implemented.
- Durable steering recovery is not implemented.
- In-flight provider and tool work cannot resume after process crash.
- Event replay is not implemented.
- Stale writer-lock recovery is not implemented.
- Credential validation uses a minimal authenticated model request and can
  consume a small number of billable tokens.
- Provider credential validity does not prove entitlement to every model in a
  provider's static catalog.
- External resource conflicts across Sessions are not coordinated; concurrent
  workspace-file mutation is tracked as
  [EC-001](./engineering-challenges.md#ec-001-concurrent-file-mutation-across-sessions).
- A Session admits only one active structural run.

## Required Tests

The maintained suite covers the Agent facade, concurrent Session isolation,
synchronous busy reservation, stale-command rejection, run-correlated
envelopes, inference-only steering, persisted config restore, single-flight
open, writer-lease contention, and running close/delete rejection. Any
ownership or lifecycle change must extend these tests before changing this
contract.
