# Session Design

This document describes Session persistence and loaded runtime context inside
the Agent. It is the detailed companion to the Session overview in
[`architect.md`](./architect.md).

## Current Status

Sessions are intentionally linear. A Session is an append-only sequence of
entries stored in one JSONL file. Physical entry order is the only history
order; there is no in-file branching or tree navigation state.

The durable log and the loaded runtime context are separate concerns:

- `JsonlSessionStore` validates and appends the durable log;
- `AgentSession` restores model-visible messages once, then maintains the
  current message context incrementally in memory;
- `AgentEngine` assembles Prompt, Tools, Skills, Prompt Templates, model
  selection, and request policy into each Turn snapshot;
- `AgentRun` combines its incrementally maintained message context with the
  current Turn snapshot for each Provider request.

## Goals

- Persist each completed message and Session configuration in append order.
- Reopen a Session and reconstruct the same ordered model-visible history.
- Avoid scanning the complete durable log at every Turn boundary.
- Make a committed message visible in memory only after its append succeeds.
- Reject malformed or incompatible files instead of guessing their meaning.
- Expose lifecycle through identity-based `Agent` methods without exporting
  concrete runtimes or persistence implementations.

## Non-Goals

The current implementation does not support:

- moving an active cursor to an earlier entry;
- multiple branches inside one Session file;
- entry labels or Session display names;
- branch-scoped model or thinking-level configuration;
- cloning or forking history through a Session repository API;
- context compaction or summary entries.

If a future product requirement needs branching, it must start with an explicit
format and API design rather than reusing the linear ordering rules implicitly.

## JSONL Format

The first non-empty line is the Session header:

```json
{
  "type": "session",
  "id": "session-id",
  "timestamp": "2026-07-18T00:00:00.000Z",
  "cwd": "/workspace/project"
}
```

Every following non-empty line is one entry. Entries contain a unique `id`, an
ISO timestamp, and one of two supported types:

```ts
type SessionEntry = MessageEntry | SessionConfigurationEntry;
```

### `message`

Stores an `AgentMessage` committed during a run. User, assistant, and
tool-result messages use this entry type.

### `session_config`

Stores a complete `{ model, thinkingLevel }` replacement snapshot. The latest
valid entry is restored on open. It remains non-model-visible and does not alter
linear ordering.

```json
{
  "type": "session_config",
  "id": "019c...",
  "timestamp": "2026-07-18T00:00:00.000Z",
  "configuration": {
    "model": {
      "providerId": "github-copilot",
      "modelId": "claude-opus-4.6"
    },
    "thinkingLevel": "high"
  }
}
```

## Persistence Invariants

`JsonlSessionStore` enforces these invariants:

1. Only `message` and `session_config` entries are accepted.
2. Every entry has a non-empty unique ID and timestamp.
3. Required type-specific fields are validated before an entry is accepted.
4. Physical JSONL order is authoritative.
5. `restore()` returns a new message array and a cloned configuration value.
6. Appends are serialized inside one Store instance.
7. A line is written successfully before the in-memory entry index is updated.

The per-Session `runtime.lock` prevents two processes from opening the same log
for writes. It does not coordinate different Sessions that share a working
directory.

## Loading and Hosting

All adapter access goes through the thin `Agent` facade. Its internal
`AgentSessionManager` owns this layout:

```text
<dataDir>/sessions/<sessionId>/
  session.jsonl
  runtime.lock
```

The manager reads and validates the header before constructing the resumed
`NodeExecutionEnv`; persisted `cwd` is authoritative. Loaded Sessions are
single-flighted in-process. The writer lease is released on close, failed open,
delete, or shutdown. A close rejected because the Session is busy retains both
the loaded instance and its writer lease.

`AgentSession.load()` then performs one load-time assembly:

1. restore model-visible messages and the latest Session configuration from the
   validated Store state;
2. ask `AgentEngine` to create and validate tools bound to the Session environment;
3. ask `AgentEngine` to resolve the selected model;
4. retain the resulting configuration, tool instances, and messages in memory.

## Runtime Context

After loading, JSONL is not rescanned for each Turn. `AgentSession.messages` is
the authoritative model-visible context for that loaded runtime.

A complete message commit has this order:

```text
AgentRun
  -> AgentRunPort.commitMessage(message)
  -> JsonlSessionStore.appendMessage(message)
  -> AgentSession.messages.push(message)
  -> emit message_end
```

If persistence fails, the message is not added to runtime context and
`message_end` is not emitted. When a Run starts, `AgentSession` copies its
current message array once into `AgentRunInput`. `AgentRun` adds every prompt,
assistant message, steering message, and tool result to its own context as the
same committed messages are added to `AgentSession.messages`. Later Turn
refreshes update Engine-owned execution assets without replacing or copying the
Run's complete message array.

Closing and reopening a Session discards the loaded array and reconstructs it
once from the durable log, which also verifies that incremental memory state
and persistence converge.

## Initial Context Restoration

Restoration scans validated entries once in physical order. `message` entries
contribute their stored messages; `session_config` entries replace the restored
configuration and never enter model context.

## Internal Modules

- `src/agent.ts` delegates Session lifecycle and run commands without owning
  their behavior.
- `src/session/agent-session-manager.ts` owns identity routing, discovery,
  loaded runtimes, environments, and lifecycle.
- `src/session/agent-session.ts` owns the loaded in-memory context,
  configuration buffering, steering, notifications, and one-active-run
  lifecycle.
- `src/session/steering-queue.ts` owns the Session's one-at-a-time steering
  storage and drain rollback.
- `src/session/storage/jsonl-session-store.ts` owns JSONL parsing, validation, ordered
  entries, serialized appends, and load-time state restoration.
- `src/engine/agent-engine.ts` owns shared Prompt, resource, tool-factory,
  model, request-policy, and snapshot assembly behavior.
- `src/session/storage/session-store-lease.ts` owns per-log writer exclusion.

## Evolution Policy

The project has one supported persistence shape. Format changes must update the
writer, parser, tests, and this document in the same change. Development data
using a replaced shape is discarded rather than supported by alternate parsers
or compatibility branches.
