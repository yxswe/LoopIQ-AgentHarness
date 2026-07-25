# Multi-Session Runtime Design

Status: Implemented behavior

Last audited: 2026-07-25

This document defines current multi-Session ownership, concurrency, hosting, and
adapter contracts. `Agent` is the sole application entry; concrete hosts,
Sessions, engines, and run ports are internal and addressed through explicit
Session and run identities.

## Runtime Structure

```text
CLI / Server adapters
        |
        v
      Agent
   |             |
   v             v
ModelRuntime  NodeSessionHost
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

Different Sessions may use the same `cwd` and still run concurrently.

## Ownership

| State or capability | Owner |
| --- | --- |
| Adapter commands and Session/run identity routing | `Agent` |
| Built-in tool installation and application shutdown | `Agent` |
| Supported provider registry, credential operations, and model catalog | `ModelRuntime` |
| Global default provider/model pair | Agent settings (`agent.json`) |
| Persisted provider credentials | `NodeCredentialStore` (`credentials.json`) |
| Online credential-validation cache | `ModelRuntime` memory |
| Model streaming capability | Shared dependency captured by `AgentEngine` |
| Current context and turn snapshot | One `AgentRun` |
| Provider stream and partial assistant message | One `AgentRun` |
| Run input, pending messages, and outcome | One `AgentRun` |
| Session storage and writer | `AgentSession` |
| Queues and queue modes | `AgentSession` |
| Model/thinking/tools/resources/stream config | `AgentSession` |
| Tool instances and `ExecutionEnv` | `AgentSession` |
| Hook registrations and event sequence | `AgentSession` |
| Lifecycle state and run control channel | `AgentSession` |
| Loaded Session map and discovery | `SessionHost` |
| Node paths and writer lease | `NodeSessionHost` |
| CLI formatting and exit codes | CLI adapter |
| HTTP policy and SSE buffering | Server adapter |

## Agent

`Agent` is the application composition root and the only surface imported by
Server and CLI adapters:

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

`createAgent({ dataDir })` asynchronously initializes local settings and stores,
registers the eleven supported providers in one internal `ModelRuntime`, creates
one `NodeSessionHost`, and installs built-in tools for every Session. Creation
does not log in, validate credentials, refresh OAuth, or access a provider. The
Agent returns serializable summaries, snapshots, and handles rather than
concrete provider, host, engine, or Session objects.

## Internal AgentEngine

`AgentEngine` is Session-stateless. It may retain shared services designed for
concurrent use, currently the model runtime's streaming capability, but it must not retain a current
Session, run, context, queue, event bus, writer, or abort controller.

```ts
export interface AgentEngine {
  run(input: AgentRunInput, port: AgentRunPort): Promise<AgentRunOutcome>;
}
```

Every call creates a fresh `AgentRun`. Correct isolation comes from object
ownership rather than a global scheduler.

## Internal AgentRunPort

The Session supplies narrow capabilities instead of exposing itself:

```ts
export interface AgentRunPort {
  takeNextTurn(): Promise<AgentMessage[]>;
  drainSteering(): Promise<AgentMessage[]>;
  drainFollowUp(): Promise<AgentMessage[]>;
  commitMessage(message: AgentMessage): Promise<void>;
  hasPendingWrites(): boolean;
  flushPendingWrites(): Promise<void>;
  createTurnSnapshot(signal: AbortSignal): Promise<TurnState>;
  emit(event: AgentEngineEvent, signal?: AbortSignal): Promise<void>;
  emitHook(event: AgentHookEvent, signal?: AbortSignal): Promise<unknown>;
}
```

Queue methods own update notification and drain rollback behavior.
`commitMessage()` persists before `message_end`. Save-point ordering is owned by
the run, while concrete storage and snapshot construction remain Session-owned.

The concrete port closure is permanently bound to one run ID and validates that
identity before Session access.

## Internal AgentSession

Each loaded Session owns:

- durable Session identity and metadata;
- `Session`, `SessionWriter`, and `ExecutionEnv`;
- instantiated tools and active-tool selection;
- resources and system-prompt provider;
- model, thinking level, and stream options;
- steering/follow-up modes and message queues;
- hook dispatcher, subscribers, runtime ID, and event sequence;
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
Before accepting a new run, the Agent requires a persisted credential for the
Session's provider and lets the model runtime resolve or refresh it. A failed
preflight creates no run ID. An in-process provider-use guard spans preflight
through run settlement and excludes explicit credential mutation without
becoming a Session run reservation. After preflight, Session-to-run commands use
two channels:

- queues carry steering, follow-up, and next-turn messages;
- `AgentRunController` carries whole-run abort and provider-only interruption.

Run-to-Session information is incremental:

1. progress events stream through the run-bound port;
2. complete messages are committed immediately;
3. `message_end` follows successful commit;
4. turn boundaries flush writes and rebuild snapshots;
5. `AgentRunOutcome` summarizes already-committed work;
6. `AgentSession` emits `run_settled` and resolves the handle.

The final outcome is not a transaction that writes all run messages at once.

## Internal NodeSessionHost

`NodeSessionHost` implements the Agent's durable Session lifecycle:

```ts
export interface SessionHost {
  create(options: CreateSessionOptions): Promise<AgentSession>;
  open(sessionId: string): Promise<AgentSession>;
  list(): Promise<SessionSummary[]>;
  close(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  shutdown(options?: { abortRunning?: boolean }): Promise<void>;
}
```

Opening an already loaded Session returns the same `AgentSession`. Concurrent
opens of one unloaded Session share one initialization promise. Failed
initialization removes its in-flight entry so a later call can retry.

The default layout is:

```text
<dataDir>/
  agent.json
  credentials.json
  sessions/
    <sessionId>/
      session.jsonl
      runtime.lock
```

The JSONL header's `cwd` is authoritative on resume. The host reconstructs the
environment, tools, persisted runtime config, and Session runtime before
publishing the loaded instance.

## Writer Lease

The Node adapter acquires a per-Session process lease before writable open.
Another process receives `AgentRuntimeError("session_locked")`. The lease is
released on close, failed initialization, delete, or shutdown.

The lease protects one Session JSONL file from duplicate writers. It does not
lock the Session's working directory.

## Runtime Configuration Persistence

Model, thinking level, and active tool names are stored as complete replacement
snapshots in reserved custom entries:

```text
loopiq.session_config
```

Resume scans physical entry order and uses the latest valid snapshot. Runtime
configuration entries are excluded from model context.

The global default is one atomic `ModelReference` in `agent.json`. It may
reference a registered provider without a credential and affects only new
Sessions. Existing Sessions retain their persisted provider/model pair.

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

- Automatic compaction is not integrated.
- Durable steering/follow-up recovery is not implemented.
- In-flight provider and tool work cannot resume after process crash.
- Event replay is not implemented.
- Stale writer-lock recovery is not implemented.
- Credential validation uses a minimal authenticated model request and can
  consume a small number of billable tokens.
- Provider credential validity does not prove entitlement to every model in a
  provider's static catalog.
- External resource conflicts across Sessions are not coordinated.
- A Session admits only one active structural run.

## Required Tests

The maintained suite covers the Agent facade, concurrent Session isolation,
synchronous busy reservation, stale-command rejection, run-correlated
envelopes, inference-only steering, persisted config restore, single-flight
open, writer-lease contention, and running close/delete rejection. Any
ownership or lifecycle change must extend these tests before changing this
contract.
