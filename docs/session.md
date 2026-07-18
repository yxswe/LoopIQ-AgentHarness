# Session Design

This document describes the current Session persistence model in
`@loopiq/agent-core`. It is the detailed companion to the Session overview in
[`architect.md`](./architect.md).

## Current Status

Sessions are intentionally linear. A Session is an append-only sequence of
entries stored in one JSONL file. Physical entry order is the only history
order; there is no active leaf, parent pointer, in-file branch, or tree
navigation state.

The current format version is `4`. Version 4 establishes the linear model and
is deliberately incompatible with the legacy version 3 tree format.

## Goals

- Persist each completed message and supported extension entry in append order.
- Reopen a Session and reconstruct the same ordered history.
- Build model context deterministically from that ordered history.
- Support context compaction without introducing branches.
- Reject malformed or incompatible files instead of guessing their meaning.
- Keep the Session subsystem internal to `AgentHarness` until a narrower public
  Session API is required.

## Non-Goals

The current implementation does not support:

- moving an active cursor to an earlier entry;
- multiple branches inside one Session file;
- persisted leaf or HEAD records;
- entry labels or Session display names;
- branch-scoped model, thinking-level, or active-tool configuration;
- cloning or forking history through a Session repository API;
- automatic migration of legacy version 3 tree Sessions.

These capabilities should not be partially restored inside version 4. If a
future product requirement needs branching, it must start with an explicit
format and API design rather than reusing the linear ordering rules implicitly.

## JSONL Format

The first non-empty line is the Session header:

```json
{
  "type": "session",
  "version": 4,
  "id": "session-id",
  "timestamp": "2026-07-18T00:00:00.000Z",
  "cwd": "/workspace/project"
}
```

Every following non-empty line is one `SessionEntry`. Entries contain a unique
`id`, an ISO timestamp, and one of four supported types:

```ts
type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | CustomEntry
  | CustomMessageEntry;
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

### `custom_message`

Stores extension content that is converted into a custom Agent message when
context is rebuilt. The `display` flag remains presentation metadata.

## Linear Invariants

The storage implementation enforces the following invariants when opening or
appending:

1. The header version must be exactly `4`.
2. Only the four documented entry types are accepted.
3. Every entry has a non-empty unique ID and timestamp.
4. Required type-specific fields are validated before an entry is accepted.
5. A compaction entry's `firstKeptEntryId` references an earlier entry in the
   same file.
6. Entry order is the physical JSONL order.
7. Entries do not contain `parentId`, `leaf`, or other tree-navigation fields.
8. `getEntries()` returns a new array so callers cannot reorder storage state in
   memory.

An append writes the JSONL line before updating the in-memory entry list. A
failed write therefore does not expose an entry that was not persisted.

## Open-or-Create Behavior

`AgentHarness.create({ cwd, sessionPath, ... })` owns Session construction:

1. Build a `NodeExecutionEnv` from `cwd`.
2. Check whether `sessionPath` exists.
3. Open and validate an existing file, or create a new version 4 file when the
   path is absent.
4. Wrap the storage in `Session` and pass it to the private harness constructor.

Only an actual missing path triggers creation. Permission, file-type, and other
filesystem failures are propagated and must never cause an existing file to be
overwritten.

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

- `src/base/session-types.ts` defines the four entry types, metadata,
  `SessionStorage`, and pending writes.
- `src/session/jsonl-storage.ts` validates, creates, opens, and appends version 4
  JSONL files.
- `src/session/session.ts` provides ordered append helpers and context rebuilding.
- `src/session/session-writer.ts` serially flushes buffered writes.
- `src/session/storage-utils.ts` contains storage error conversion and the
  storage-to-Session adapter.
- `src/context/compaction/` computes and generates compaction summaries over the
  ordered Session entries.

The former `JsonlSessionRepo`, fork API, path-to-root traversal, leaf tracking,
and repository option types have been removed. They were not used by the
current `AgentHarness` construction path and contradicted the linear format.

## Legacy Version 3 Sessions

Version 3 represented entries as a tree using `parentId` and could persist a
`leaf` record whose `targetId` selected the active branch. Interpreting those
files as linear logs can silently restore the wrong conversation.

For that reason, version 4 rejects version 3 files with an
`invalid_session` error. The existing file is left unchanged. Migration, if it
is needed later, must be an explicit tool that chooses which legacy branch to
materialize as a new linear version 4 Session.

## Future Evolution

Additions that preserve linear ordering may extend version 4 when they remain
backward-compatible. Any change that alters ordering, introduces navigation
state, or changes the meaning of existing entries requires a new Session format
version and an explicit compatibility or migration policy.
