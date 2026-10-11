# 02. Durable Session Execution

Status: Planned.

## 1. Outcome and scope

Implement R2: a Session binds each logical submission to one durably accepted
Run and retains that Run's identity and outcome across
process restarts. Queries resolve lost acknowledgments without starting work;
submission deduplication does not promise exactly-once tool effects.

The [consolidated design](../app-server-runtime-design.md), especially sections
3, 5, 6, and 7.3, is authoritative. This document makes those decisions executable.
R2 owns Session creation, writer ownership, Run admission/control, history,
outcomes, and deletion evidence. R3 continues to own models, credentials,
configuration, environments, and tools; `packages/ai` remains read-only.

[03](./03-runtime-host-and-connection.md) consumes the Agent facade and supplies
process identity and safe host recovery. [04](./04-appserver-session-application.md)
coordinates the catalog. [05](./05-session-observation.md) owns snapshot/live
delivery. This work adds no execution queue, automatic replay, workspace lock,
remote CLI transport, SQL index, or token-event journal.

## 2. Prerequisites and source map

Read [01](./01-protocol-contracts.md) first for domain types, operation shapes,
reason codes, and limits. R2 exposes adapter-neutral values through `Agent`;
R1 maps them to wire contracts without importing concrete Session objects.
All new interfaces and source changes described below are proposed work.

| Existing source or documentation | Verified starting point; proposed change |
| --- | --- |
| [Architecture](../../architect.md) | Agent is the sole application entry; retain the ownership split. |
| [Session format](../../session.md) | Unversioned linear history; replace its current discard-old-formats policy with explicit v2 compatibility. |
| [Lifecycle](../../techniquedocs/agent-runtime.md), [multi-Session](../../techniquedocs/multi-session-runtime.md), [Run flow](../../techniquedocs/agent-run.md) | Current in-memory reservation, awaited notifications, and pre-release terminal callback. |
| [Agent facade](../../../packages/agent/src/agent.ts), [construction](../../../packages/agent/src/create-agent.ts), [exports](../../../packages/agent/src/index.ts) | Add commands by delegation; construction remains wiring only. |
| [Session manager](../../../packages/agent/src/session/agent-session-manager.ts) | Generates creation IDs, single-flights open, and skips invalid directories during listing; add stable-ID operations and authoritative inventory. |
| [Session owner](../../../packages/agent/src/session/agent-session.ts), [contracts](../../../packages/agent/src/session/session-contracts.ts) | `startRun()` reserves synchronously in memory; add durable admission and retained lookup. |
| [JSONL store](../../../packages/agent/src/session/storage/jsonl-session-store.ts) | Only message/configuration/compaction entries; serialized `appendFile` has no fsync boundary or Run associations. |
| [Writer lease](../../../packages/agent/src/session/storage/session-store-lease.ts) | Exclusive `wx` file stores PID/time only; no safe stale-owner recovery. |
| [Filesystem contract](../../../packages/agent/src/base/env.ts), [Node environment](../../../packages/agent/src/env/nodejs.ts) | Store access exposes read/write/append only; Node cleanup is currently a no-op. |
| [Atomic JSON primitive](../../../packages/agent/src/persistence/json-file.ts), [file lock](../../../packages/agent/src/persistence/file-lock.ts) | File sync plus rename lacks directory sync; PID-based lock recovery is not sufficient proof for the new execution guarantees. |
| [Run port](../../../packages/agent/src/engine/agent-run-port.ts), [outcome](../../../packages/agent/src/engine/agent-run-outcome.ts), [events](../../../packages/agent/src/session/event-envelope.ts) | Add stable commit associations and retained result metadata without moving the loop into Session management. |
| [CLI implementation](../../../packages/cli/src/cli.ts), [CLI contract](../../features/cli-headless-readiness.md) | Direct Agent calls and one external completion record must remain compatible. |

New source placements are proposed: `packages/agent/src/session/storage/session-store-file.ts`
for Session-owned durable file operations, and
`packages/agent/src/session/storage/session-deletion-ledger.ts` for deletion evidence.
Keep gates and capacity accounting with the manager/Session owners unless an
extracted module has a distinct responsibility. Add no generic runtime folder.

## 3. Contracts and invariants

### 3.1 Versioned records and durability

Add a v2 header discriminator, using `formatVersion: 2` as the proposed spelling.
Read current unversioned files as legacy; reject unsupported future versions.
Migrate under exclusive writer ownership by writing and syncing a replacement,
renaming it atomically, and syncing its containing directory. Preserve Session
identity, workspace, entry IDs, order, messages, configuration, and compaction.
Legacy messages retain `runId: null`; never manufacture historical Runs.

| v2 record or association | Required retained data |
| --- | --- |
| Session creation metadata | Immutable supplied creation parameters/fingerprint plus resolved workspace and effective nonsecret configuration. |
| `run_accepted` | Unique entry ID, submission ID, reserved Run ID, Runtime boot ID, exact submitted text, input fingerprint, and acceptance time. |
| Message associations | Run ID for new execution messages; submission ID on the initial user item; stable display item IDs and tool-call/result relationships. |
| `run_settled` | Run/submission identity, immutable outcome, completion time, final assistant item IDs, output item references, and result details. |

Validate lifecycle relationships as well as individual records: one acceptance
per submission, one Run per acceptance, at most one terminal per Run, and valid
output references. Reject conflicts or terminals with no acceptance. Receipt
records never enter model context. Keep accepted mappings and terminal records
until Session deletion; there is no receipt expiry in v1.

The proposed file capability must expose ordered append-and-sync, atomic durable
replacement, and recovery truncation. `appendFile` resolving is insufficient.
Publish a committed message only after its required durable write; keep the
existing append-before-memory order for both messages and compaction. Sync file
creation/replacement/removal directory entries before acknowledging their effect.

Under exclusive ownership, discard only an incomplete final v2 JSONL line left
by a torn append, then sync the truncation. A malformed newline-terminated
record, invalid lifecycle reference, duplicate ID, or interior corruption fails
recovery. Never continue appending after an ambiguous write until reconciliation
has rebuilt the authoritative indexes and resolved the fault.

### 3.2 Admission and retained queries

Proposed facade additions are `startRun`, `readRun`, `readRunResult`, `steerRun`,
and `abortRun`, using the domain semantics in 01. Keep existing `run`, `steer`,
and `abort` signatures for direct consumers. Existing direct starts allocate an
internal submission ID and share durable lifecycle code; they need no network.
Apply the remote text-only 64 KiB UTF-8 limit to the new remote command surface,
without shrinking the existing CLI prompt limit or changing `AgentInput`.

Each Session has one mutation gate shared by start, lifecycle transitions,
control admission, deletion, and authoritative submission lookup. Acquire that
gate before the aggregate capacity guard; no code waits for a Session while
holding the capacity guard. Reserve/release a counter under the capacity guard,
then release that guard before I/O. Never hold a Session gate over execution or
an abort wait. Different Sessions, including equal workspaces, progress independently.

For a live Session, look up a submission before checking busy state or capacity.
Equal immutable input returns the original Run, including a settled Run when a
newer one is active; changed input yields `SUBMISSION_CONFLICT`. Fingerprint the
exact validated input and retain the original value for equality verification;
do not silently trim or normalize accepted text.

For a new submission, validate local configuration and input, reject a deleted,
faulted, locked, or busy Session, and reserve a slot. The default limit is four;
accepted, running, and settling Runs consume slots. Append and fsync acceptance
before invoking the engine, any provider, or any tool. Then install/schedule the
Run and return its identity without awaiting completion. Configuration checks
do not add online credential validation; authentication remains request-time R3 work.

A failed or ambiguous acceptance write starts no execution and faults that
Session for reconciliation. It is not proof of non-acceptance. Reconcile the
record and any provisional reservation before admitting more work there.
`notAccepted` is valid only for a submission lookup serialized with acceptance
in a complete v2 namespace. An absent Run ID, legacy task, corrupt log, or
unavailable store gives `unknown` or a storage error. A later same-ID manual
retry and a delayed original request must converge on the same acceptance.

### 3.3 Control and settlement

`steerRun` targets the exact active Run and acknowledges queue insertion only.
The queue remains transient; it has no durable retry/deduplication contract.
Preserve normal safe-point consumption and inference-only interruption after
queue insertion. Whole-run abort clears queued steering and takes precedence.
Lost steering acknowledgments remain uncertain; no automatic resend is added.

`abortRun` validates/signals under the gate and waits outside it. Multiple
waiters can await one settlement. A timeout only detaches its waiter. A known
settled target returns its retained outcome, even while a newer Run is active;
a mismatched active target gets `STALE_RUN` and cannot cancel that newer Run.

Settlement means: execution has ended; committed messages and pending Session
configuration have flushed; Run-owned cleanup has completed; terminal outcome
has been appended and synced; active handle and capacity reservation have been
released under Session ordering. Only afterward expose `state: settled`, resolve
remote abort waiters, or publish public settlement. Normal completion may beat
abort, so the response reports the actual outcome.

The current internal `run_settled` callback precedes handle release. It is not
the new public guarantee and cannot be forwarded as one unchanged. A terminal
write failure leaves storage faulted and blocks new Runs; it cannot announce
durable success. Listener/delivery failure cannot rewrite a retained terminal.
Keep idle loaded Sessions and their Session resources until shutdown or deletion.

### 3.4 Creation, deletion, and inventory

Add a stable-ID creation entry through `Agent`. Under lifecycle ordering,
check tombstones, compare any existing immutable creation fingerprint, then
validate the Runtime-local existing directory and resolvable configuration.
Remote explicit cwd is absolute; a missing cwd uses the Runtime-local default.
Persist creation metadata and initial configuration durably before success.
Equal retries return the original Session and actual settings even if defaults
have since changed; changed supplied parameters yield `CREATION_CONFLICT`.
Creation makes no provider call. Keep the existing local creation convenience API.

Proposed durable data file: `~/.loopiq/session-deletions.json`, outside individual
Session directories. Its Session-owned ledger stores only Session ID, stable
deletion operation ID, cleanup state, and timestamps. Serialize mutations across
processes and use synced atomic replacement, including directory sync. The
existing JSON/lock helpers need their guarantees strengthened before reuse here.

Deletion first rejects accepted/running/settling Sessions. Under the Session
gate and writer ownership, persist intent before closing idle resources or
removing history. Intent blocks starts, opens for execution, and recreation.
Remove only Agent-owned Session state; never traverse/delete `workspaceDir`.
Sync removal, then complete the retained tombstone; only completion means deleted.
Startup resumes incomplete cleanup. Same-operation retries/query return
`notStarted`, `deleting`, or `deleted`; unavailable evidence is an error.
Every retained tombstone prevents ID reuse, including delayed start/create calls,
which return `SESSION_DELETED`. Do not garbage-collect tombstones in v1.

Provide an authoritative inventory capability separate from best-effort listing.
Report Session metadata, creation evidence, execution availability, and deletion
tombstones without transcript text. A failed/partial scan must be explicit;
missing data cannot prove absence or successful deletion. Direct CLI-created
Sessions are discoverable; a live CLI writer makes that Session unavailable.
Catalog names, pending rows, and their reconciliation remain work for 04.

### 3.5 Ownership, crash recovery, and history

New Session leases record a unique owner token, boot identity, and process-start
identity as well as PID. Recovery verifies the old owner is dead and reacquires
atomically; release must not unlink a replacement owner's lease. PID reuse or
ambiguous legacy leases require local cleanup, never automatic removal. The
host-service lock in 03 supplements per-Session leases and does not block all CLI use.

Before admitting work, establish Session ownership and the managed-subprocess
recovery result supplied by 03. If storage or subprocess ownership is unsafe,
return `RECOVERY_REQUIRED`. Preserve known terminal records; append and sync
`interrupted` for accepted Runs from a lost boot without a terminal. This also
applies when the crash preceded the first model request. Never resume tools,
repeat accepted input, roll back workspace files, or reconstruct uncommitted text.

Allocate stable display item IDs before streaming starts and retain associations
when messages commit; preserve a tool-call ID separately from its display ID.
Expose committed physical boundaries and display-message reads through a chosen
boundary for 05. These reads include messages retained behind compaction rather
than reusing `restore()`'s compacted model context. Accepted input not yet saved
as a user message remains identifiable by submission ID for `uncommittedInputs`.

Retained results work without a live handle and report `RUN_NOT_SETTLED` before
settlement. Preserve known stop reason and usage; compaction or missing provider
usage must yield partial/unavailable coverage, never invented zero counts.
Full result responses retain the 16 MiB encoded bound and explicit protocol
size error; they never silently truncate. Full snapshot assembly belongs to 05.

## 4. Implementation flow

```mermaid
sequenceDiagram
    participant Host as R1 or direct Agent caller
    participant Session as R2 Session gate
    participant Slots as Capacity guard
    participant Log as Session store
    participant Run as Engine and R3
    Host->>Session: start with immutable submission
    Session->>Session: Check tombstone and retained submission
    alt Equal retained submission
        Session-->>Host: Original Run identity
    else New submission
        Session->>Slots: Reserve while Session gate held
        Slots-->>Session: Reserved; capacity guard released
        Session->>Log: Append run_accepted and fsync
        Log-->>Session: Durable acceptance
        Session->>Session: Install Run; release gate
        Session->>Run: Schedule execution
        Session-->>Host: Run identity
        Run->>Session: Commit messages; finish execution
        Session->>Session: Enter settling; flush state and cleanup
        Session->>Log: Append terminal and fsync
        Log-->>Session: Durable terminal
        Session->>Slots: Release reservation under Session ordering
        Session->>Session: Clear active handle; publish settled view
        Session-->>Host: Settlement or abort result
    end
```

Execution and notifications can precede the start response. Failure before
confirmed acceptance never reaches the engine; ambiguous persistence enters
reconciliation. Recovery appends interruption without restarting execution.
Deletion shares admission ordering: an active reservation rejects deletion;
durable intent rejects the next start.

## 5. Ordered work packages

- [ ] **D02-01 — Define additive contracts.** Extend the existing facade,
  Session contracts, error mapping, and composition wiring for durable commands,
  boot identity, and configured capacity. Keep internal runtime classes private.
- [ ] **D02-02 — Implement durable file operations and v2 parsing.** Add the
  proposed Session store file capability; migrate valid legacy logs atomically,
  validate lifecycle records, and inject failures at append/sync/rename boundaries.
- [ ] **D02-03 — Establish writer recovery.** Extend existing leases with owner
  tokens/process-start identity; test live contention, dead owners, replacement
  races, and ambiguous legacy locks before enabling automatic recovery.
- [ ] **D02-04 — Add stable creation and deletion evidence.** Implement the
  proposed deletion ledger, lifecycle gates, creation fingerprint comparisons,
  restartable cleanup, tombstone checks, and complete inventory results for 04.
- [ ] **D02-05 — Replace in-memory-only admission.** Add the short Session gate,
  aggregate reservation, duplicate-first lookup, durable acceptance, and query
  indexes rebuilt from the log. Never wrap execution with a receipt written later.
- [ ] **D02-06 — Associate execution output.** Extend commits and Run metadata
  with stable item/Run/submission associations, retained result details, and
  committed-boundary reads. Coordinate the exact view capture with 05.
- [ ] **D02-07 — Implement public settlement and control.** Flush, clean up,
  persist terminal, and release before public settlement; isolate persistence
  faults; add retained abort results and keep waits outside mutation gates.
- [ ] **D02-08 — Recover without execution.** Under established ownership,
  finish deletion intents and interrupt nonterminal lost-boot Runs. Connect the
  recovery admission barrier to 03; fail closed on uncertain subprocess ownership.
- [ ] **D02-09 — Preserve direct consumers.** Route local APIs through shared
  lifecycle internals, keep CLI formats/limits and reentrant event behavior
  explicitly tested, and update code-coupled documentation with implementation.

## 6. Failure cases and acceptance

Use fake providers, temporary Agent Homes/workspaces, barrier-controlled writes,
and child processes. Count provider/tool starts independently of emitted events.

| ID | Trigger | Exact observable assertion |
| --- | --- | --- |
| T02-01 | Open/migrate legacy history containing compaction. | Original IDs/order/configuration remain; model context matches; display history includes pre-compaction messages with null Run identity. |
| T02-02 | Tear final v2 line; separately corrupt a complete or interior record. | Only the incomplete suffix is truncated under ownership; complete/interior corruption prevents admission without rewriting valid bytes. |
| T02-03 | Concurrent distinct starts on one Session. | One durable acceptance and one provider start; the other gets `SESSION_BUSY` with no receipt or queue. |
| T02-04 | Retry accepted input while a newer Run is active and capacity full; retry changed text. | Equal input returns the original Run with zero added starts; changed input returns `SUBMISSION_CONFLICT`. |
| T02-05 | Pause acceptance fsync before releasing its barrier. | Provider/tool counters remain zero and no successful acceptance reply exists until sync succeeds. |
| T02-06 | Fail append/sync after a possible acceptance write. | No execution starts; Session blocks new work; lookup never asserts `notAccepted` until authoritative reconciliation. |
| T02-07 | Kill before acceptance, after acceptance, before terminal sync, and after durable terminal. | Unaccepted work never starts; each retained nonterminal becomes interrupted; durable terminals remain unchanged; restart causes zero provider/tool starts. |
| T02-08 | Delay original start until after a negative submission query and same-ID manual retry. | Both attempts identify one Run; log contains one acceptance and provider counter is one. |
| T02-09 | Query absent Run ID, legacy task, unreadable records, and absent v2 submission. | Only complete authoritative v2 submission absence returns `notAccepted`; other cases return explicit unknown/error. |
| T02-10 | Hold four Runs in accepted/running/settling states and start a fifth. | Fifth receives `CAPACITY_EXCEEDED` without acceptance; capacity becomes reusable only after ordered release. |
| T02-11 | Run two Sessions with the same cwd. | Both provider barriers are reached concurrently; contexts remain separate; no workspace reservation is created. |
| T02-12 | Pause final state flush, cleanup, terminal sync, and reservation release in turn. | Public settled Run state/update and abort response remain unavailable at every barrier; after release they report the retained outcome. Durable item upserts may precede settlement. |
| T02-13 | Fail terminal persistence after execution ends. | No durable-success announcement; new Session work is blocked; recovery either preserves a valid terminal or records interruption. |
| T02-14 | Send stale controls, concurrent aborts, and abort after normal completion. | Newer Run is untouched; concurrent waiters receive one actual terminal result; completed target returns completed. |
| T02-15 | Steer during inference/tools; lose its response; then abort. | Inference interruption keeps the same Run; tools are not interrupted by steer; abort clears queued input; restart/reconnect never replays steering. |
| T02-16 | Retry stable-ID create after defaults change, then alter supplied parameters. | Equal request returns the same Session/configuration; altered request conflicts; provider counter remains zero. |
| T02-17 | Create with missing/non-directory cwd or no resolvable model. | Configuration/workspace error occurs without a successful creation or model call; no partially initialized Session is exposed as ready. |
| T02-18 | Delete an active Session, then delete it after settlement. | Busy deletion creates no intent; successful deletion removes history/receipts, retains tombstone, and leaves workspace files byte-identical. |
| T02-19 | Kill after delete intent, history removal, and tombstone completion. | Same operation query/retry converges to deleted; no new Run is admitted after intent; success is impossible before durable completion. |
| T02-20 | Delay a start/create until after deletion. | Both return `SESSION_DELETED`; neither recreates the directory, accepts a Run, nor invokes a tool. |
| T02-21 | Contend with live CLI writer, dead identified writer, and ambiguous legacy lease. | Live writer retains ownership; identified dead owner can be reclaimed once; ambiguous legacy lease returns `RECOVERY_REQUIRED` without removal. |
| T02-22 | Inject unreadable/corrupt entry into inventory scan. | Inventory reports incomplete/error evidence; it never reports authoritative absence or a completed deletion for that Session. |
| T02-23 | Reopen settled results after compaction; exceed result size bound. | Stable item references resolve; terminal/details survive without handles; missing usage is explicit; oversize errors preserve stored data. |
| T02-24 | Run current CLI tests with shared lifecycle changes. | Direct execution needs no server; fresh/resume behavior, exit codes, schema version, and one external `run_completed` record remain unchanged. |
| T02-25 | Inject an unsafe managed-process ownership verdict at the recovery boundary. | Affected Session returns `RECOVERY_REQUIRED` and provider/tool counters remain zero; actual subprocess cleanup and process-level proof belong to 03. |

## 7. Validation commands

Run from the repository root. Existing commands below do not yet prove T02 cases.

```sh
npm run test -w @loopiq/agent -- src/session/storage/jsonl-session-store.test.ts src/session/agent-session.test.ts src/session/agent-session-manager.test.ts
npm run build
npm run test -w @loopiq/cli
npx biome check packages/agent/src packages/cli/src
git diff --check
```

Tests to add (proposed files) and run after implementation:

```sh
npm run test -w @loopiq/agent -- src/session/durable-session-execution.test.ts src/session/session-crash-recovery.test.ts
```

The proposed files live under `packages/agent/src/session/`; they must contain
the T02 fixtures, including real child-process kills and filesystem fault
injection. Supplement existing suites rather than treating `--passWithNoTests`
as proof. No new npm script is assumed. Use local fakes only; never run provider
credential validation, model refresh, or paid model requests for these checks.

## 8. Migration and documentation updates

Upgrade parser, writer, migration, and tests together before the execution host
consumes these APIs. Validate legacy files before replacement; failure leaves
the old file intact. Test interruption around file and directory sync. Current
source CLI works with the shared upgraded library; separately installed old
binaries are not promised v2 compatibility. Operational guidance must state
that downgrade limitation and manual handling of ambiguous old leases.

With implementation, update the linked Session format, runtime lifecycle,
multi-Session, Run-flow, and CLI documents and the high-level architecture map.
Document the proposed deletion ledger layout, storage-fault behavior, public
settlement boundary, namespace absence rules, and retained result associations.
Keep this proposal Planned until tests establish durability and crash safety.

## 9. Completion checklist

- [ ] D02-01 through D02-09 and T02-01 through T02-25 are implemented and pass.
- [ ] Acceptance and terminal sync boundaries are proven by fault injection.
- [ ] Crash tests prove writer exclusion, interruption, and deletion recovery.
- [ ] No accepted submission or tombstone is expired; no recovery executes tools.
- [ ] 03 receives facade-only APIs, 04 receives complete inventory/deletion evidence,
  and 05 receives stable associations plus bounded committed-history reads.
- [ ] R3 ownership and direct CLI behavior remain intact; documentation matches code.
