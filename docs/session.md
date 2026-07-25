# Session Design

This document describes the current Session persistence model inside the Agent.
It is the detailed companion to the Session overview in
[`architect.md`](./architect.md).

## Current Status

Sessions are intentionally linear. A Session is an append-only sequence of
entries stored in one JSONL file. Physical entry order is the only history
order; there is no in-file branching or tree navigation state.

## Goals

- Persist each completed message and supported extension entry in append order.
- Reopen a Session and reconstruct the same ordered history.
- Build model context deterministically from that ordered history.
- Support context compaction without introducing branches.
- Reject malformed or incompatible files instead of guessing their meaning.
- Expose lifecycle through identity-based `Agent` methods without exporting
  hosts, concrete Sessions, or raw storage implementations.

## Non-Goals

The current implementation does not support:

- moving an active cursor to an earlier entry;
- multiple branches inside one Session file;
- entry labels or Session display names;
- branch-scoped model, thinking-level, or active-tool configuration;
- cloning or forking history through a Session repository API.

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

Every following non-empty line is one `SessionEntry`. Entries contain a unique
`id`, an ISO timestamp, and one of four supported types:

```ts
type SessionEntry =
  MessageEntry | CompactionEntry | CustomEntry | CustomMessageEntry;
```

### `message`

Stores an `AgentMessage` emitted during a run. User, assistant, tool-result, and
supported custom Agent messages are persisted through this entry type.

### `compaction`

Stores a generated context summary plus `firstKeptEntryId` and
`tokensBefore`. Compaction does not delete or reorder previous JSONL lines. It
changes how `buildSessionContext()` interprets the linear history.

### `custom`

Stores extension data that is not inserted into model context.

The Node Session runtime reserves `customType: "loopiq.session_config"` for
complete model, thinking-level, and active-tool snapshots. The latest valid
snapshot is restored on open. It remains non-model-visible and does not alter
linear ordering.

### `custom_message`

Stores extension content that is converted into a custom Agent message when
context is rebuilt. The `display` flag remains presentation metadata.

## Linear Invariants

The storage implementation enforces the following invariants when opening or
appending:

1. Only the four documented entry types are accepted.
2. Every entry has a non-empty unique ID and timestamp.
3. Required type-specific fields are validated before an entry is accepted.
4. A compaction entry's `firstKeptEntryId` references an earlier entry in the
   same file.
5. Entry order is the physical JSONL order.
6. `getEntries()` returns a new array so callers cannot reorder storage state in
   memory.

An append writes the JSONL line before updating the in-memory entry list. A
failed write therefore does not expose an entry that was not persisted.

## Construction and Hosting

All adapter access goes through `Agent`. It owns an internal `NodeSessionHost`
that uses this durable layout:

```text
<dataDir>/sessions/<sessionId>/
  session.jsonl
  runtime.lock
```

The host reads and validates the header before constructing the resumed
`NodeExecutionEnv`; persisted `cwd` is authoritative. Loaded Sessions are
single-flighted in-process. An exclusive `runtime.lock` file prevents a second
process from opening the same Session for writes. The lease is released on
close or shutdown. This protects only one Session log and does not coordinate
different Sessions sharing a working directory.

## Context Reconstruction

Without compaction, `buildSessionContext()` scans entries from first to last:

- `message` entries contribute their stored message;
- `custom_message` entries contribute a generated custom message;
- `custom` entries do not contribute model-visible messages.

When compaction entries exist, the latest compaction entry is authoritative.
The rebuilt context contains:

1. the compaction summary message;
2. retained entries beginning at `firstKeptEntryId` and preceding the
   compaction entry;
3. model-visible entries appended after the compaction entry.

This is still a linear interpretation. `firstKeptEntryId` is a boundary marker,
not a parent or branch pointer.

## Internal Modules

- `src/agent.ts` routes Session lifecycle and run commands by identity.
- `src/base/session-types.ts` defines the four entry types, metadata,
  `SessionStorage`, and pending writes.
- `src/session/jsonl-storage.ts` validates, creates, opens, and appends JSONL
  files.
- `src/session/session.ts` provides ordered append helpers and context rebuilding.
- `src/session/session-writer.ts` serially flushes buffered writes.
- `src/session/storage-utils.ts` contains storage error conversion and the
  storage-to-Session adapter.
- `src/runtime/agent-session.ts` owns the live single-active-run state around a
  raw Session.
- `src/node/node-session-host.ts` owns discovery, loaded instances, config
  restore, and lifecycle; `node-session-lease.ts` owns writer exclusion.
- `src/context/compaction/` computes and generates compaction summaries over the
  ordered Session entries.

## Future Evolution

The project is still in development and has one supported persistence shape.
Format changes must update the writer, parser, tests, and this document in the
same change. Development data using any previous shape is discarded rather
than supported by production parsing branches.
