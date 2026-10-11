# Session Observation and Snapshot Recovery

Status: Planned

This plan implements R1 normalization, R2 capture, and A4 observation from the
[authoritative design](../app-server-runtime-design.md); current REST/SSE lacks these guarantees.

## 1. Outcome and scope

A frontend can install a complete supported-size Session view and then receive
live changes without losing a completion or applying a delta to the wrong text.
Reconnecting to a healthy Runtime restores accumulated active text as well as
durable display history. Reconnecting after a Runtime crash restores committed
items and interrupted Run outcomes without restarting work.

R2 owns the authoritative capture boundary and durable history access. R1
converts local execution information into protocol items and updates. A4 owns
frontend observations, recovery buffers, routing, and snapshot-to-live ordering.
App-server observation state is transient; it is not another transcript store.

This document covers bounded full snapshots, revisions, subscription cleanup,
and failure recovery. Browser rendering belongs to document 06. Large-history
pagination, durable token replay, and optional features O1–O5 remain excluded.

## 2. Prerequisites and source map

| Prerequisite | Required handoff before dependent work |
| --- | --- |
| [01 Protocol contracts](./01-protocol-contracts.md) | Validated snapshot/update/observation schemas, byte limits, errors, and link-generation rules. |
| [02 Durable execution](./02-durable-session-execution.md) | Durable Run queries, stable item associations, committed-history boundaries, and public settlement after reservation release. |
| [03 Runtime host and connection](./03-runtime-host-and-connection.md) | Independent host, ordered backend dispatch, bounded delivery, replacement-link fencing, and reconnect lifecycle. |
| [04 Session application](./04-appserver-session-application.md) | Authorized Session binding resolution, production inventory reconciliation, readiness, and deletion routing. |

Projection tests can start after 01/02 contracts settle. End-to-end observation
requires all predecessors, including 04's production catalog/readiness barrier.

| Existing source | Evidence and required adaptation |
| --- | --- |
| [Agent facade](../../../packages/agent/src/agent.ts) | Add narrow capture/history access through the facade; keep concrete Sessions internal. |
| [Session owner](../../../packages/agent/src/session/agent-session.ts) | `getSnapshot()` exposes metadata only; `messages` is compacted context; listeners are awaited. |
| [Session manager](../../../packages/agent/src/session/agent-session-manager.ts) | Owns loading, leases, and identity routing; loading for observation must not start a Run. |
| [Current contracts](../../../packages/agent/src/session/session-contracts.ts) | Existing `SessionSnapshot` is not the proposed wire `SessionSnapshot`; keep the distinction explicit. |
| [Events](../../../packages/agent/src/base/events.ts) and [envelopes](../../../packages/agent/src/session/event-envelope.ts) | Bounded progress exists, but raw sequence numbers and provider objects are not the public view contract. |
| [JSONL store](../../../packages/agent/src/session/storage/jsonl-session-store.ts) | `restore()` applies compaction; whole-file reads and mutable entry arrays need a bounded display-history API. |
| [Current server](../../../packages/server/src/server.ts) | SSE directly forwards Agent envelopes and has no snapshot handshake or observation identity. |
| [Session design](../../session.md) and [context management](../../techniquedocs/context-management.md) | Preserve physical message history while model-context restoration continues to apply compaction. |

Proposed implementation locations, not existing modules: output normalization
under `packages/execution-host/src/session-observation/` and A4 under
`packages/server/src/session-observation/`. Add Session capture behavior to the
existing Session owner; do not create a generic top-level runtime utility layer.

## 3. Contracts and invariants

### 3.1 Canonical view and normalized output

Each loaded Session has one `viewEpoch` and a monotonically increasing
`viewRevision`. Increment the public revision for each normalized update,
not for internal events that produce no public change. Local envelope
`runtimeId`/`sequence` values are not a durable cursor or a wire revision.

R1 produces only `run/state`, `item/upsert`, and `item/textDelta` changes.
Every update carries `sessionId`, epoch, and view revision. Each item has a
stable `itemId`, an item revision, kind, timestamp, display text, and known
Run association. Historical items without reliable attribution use `runId: null`.
Allocate identity before streaming and retain it through durable commit;
document 02 owns the persisted association needed to recover that identity.

Convert tool arguments and results to display text or JSON text. Preserve
`toolCallId` separately from item identity. A failed tool result is an item;
it does not itself establish a failed Run. Do not forward provider runtime
objects, credential material, response headers, or growing provider partials.
Optional reasoning/debug output is not a new wire event family in this scope.

Keep the canonical projection and capture inside Runtime ownership. Any R1
conversion needed by the view must run in the Session's ordered local update
path or consume a Session-owned immutable projection captured in that path.
An asynchronously updated R1 cache read independently of the R2 boundary fails
the contract. Wire serialization can happen after capture; it cannot change W.

Local projection updates may be awaited as short in-process work. Network
enqueue and writes must not await frontend or backend delivery from an Agent
listener. Keep local listeners installed while the backend link is down;
advance the local view and durable history while skipping network enqueue.

### 3.2 Snapshot capture at one boundary

Under the same Session ordering used for view updates, capture an immutable
tuple: epoch, boundary revision W, committed log boundary B, Run views,
accumulated active items, and accepted inputs not yet committed as user items.
Capture values or immutable references; later deltas must not mutate the tuple.
The log boundary identifies a validated, durably committed prefix from 02,
not a byte count sampled independently from the filesystem.

Release the short ordering gate before reading/encoding bounded history.
Read only the prefix through B. A subsequent append cannot leak into the
snapshot even if the physical file already contains it when reading starts.
Protect the captured read against concurrent deletion/replacement: retain a
valid captured source or fail explicitly; never return mixed generations or
an empty successful history after the captured file disappears.

Display history includes recorded messages retained behind context compaction.
Do not call `restore()` or copy `AgentSession.messages` to build the transcript:
both represent model context, where old content may have become a summary.
Compaction records do not erase display items or invent user-message bubbles.
Keep the existing model-context reconstruction rules intact.

Return `items`, `activeItems`, `runs`, `currentRun`, and `uncommittedInputs`
at W. An accepted input without a committed user message appears once in
`uncommittedInputs`; after commit, the corresponding user item replaces it.
A streamed item committed after W remains active in the snapshot and becomes
committed through a later upsert with the same ID.

Publish committed item updates only after the durable commit. Publish public
`settled` only after document 02's terminal persistence and reservation release.
The current internal `run_settled` callback occurs earlier and cannot be reused
as proof of this public ordering without changing its source semantics.

### 3.3 Observation identity and handoff

A4 indexes observations by frontend connection and Session. Each attempt owns
an `observationId`, backend link generation, expected epoch, snapshot boundary,
bounded buffer, deadline, and state: recovering, flushing, live, or closed.
Authenticate and resolve the catalog binding before registering the attempt.
Register buffering before issuing backend `session/readSnapshot`.

Process backend updates in receive order. Return the snapshot and observation
ID only for the still-current attempt. `session/ready` must name that exact
observation, epoch, and W from the response. Reject a mismatched, expired, or
replaced attempt with `OBSERVATION_EXPIRED`; it cannot activate another one.

On ready, discard buffered updates at or below W and flush the contiguous
suffix above W. Keep newer arrivals behind that suffix until all older
updates have entered the frontend writer queue, then enter live mode.
Use one per-observation ordering path; awaiting a write and switching to live
in another callback would let a new update overtake the flush.

Every frontend update includes `observationId`. A duplicate or obsolete update
cannot change the installed view. Within the current epoch, apply only the
next view revision. An item delta additionally requires its exact
`baseRevision`; a complete newer upsert replaces that item's previous content.
A gap, changed epoch, or unknown delta base invalidates the observation and
requires a new snapshot. Do not fill a gap by guessing missing text.

Use 01's planned `session/observationExpired` notification with observation ID
and reason: `resyncRequired`, `runtimeUnavailable`, or `sessionDeleted`.
Enqueue only while the socket is usable; if invalidation cannot enter its bounded
writer queue, close the socket. Disconnect itself invalidates the observation;
cleanup never waits for drain. The client resnapshots, waits, or stops, respectively.

### 3.4 Bounds and reconnect behavior

| Boundary | Configurable initial limit | Required result |
| --- | --- | --- |
| Encoded full snapshot | 16 MiB | `SNAPSHOT_TOO_LARGE`; retain saved history and expose Run queries. |
| Encoded JSON message | 32 MiB | Reject the oversized message under 01's transport contract. |
| Recovering observation buffer | 2,048 updates or 8 MiB | Invalidate that attempt; discard the buffer and resnapshot. |
| Connection writer queue | 256 messages or 32 MiB | Close the slow connection; require fresh synchronization. |
| Snapshot-install deadline | 30 seconds | Expire the attempt even if execution is still producing output. |

Count encoded UTF-8 bytes, including the actual wire envelope where applicable.
The first reached count/byte bound wins. Do not silently truncate history,
drop a suffix delta, or retain an unbounded outage queue. `run/result` retains
its independent explicit 16 MiB response bound from the authoritative design.

Frontend loss removes only that connection's observations and RPC waiters.
Backend loss/replacement invalidates every observation tied to that generation;
after 03/04 readiness, obtain fresh snapshots. App-server restart reconstructs
observations on client request, never from a durable transcript copy.
Runtime restart changes the live view generation, loses uncommitted partials,
and exposes 02's durable interrupted outcomes. No recovery path starts a Run.

Unobserve is idempotent and removes both indexes, the deadline, and buffers.
Page close, last subscriber departure, and slow-client eviction do not unload
the Session, abort execution, delete history, or remove Runtime listeners.

## 4. Implementation flow

```mermaid
sequenceDiagram
    participant UI as Frontend
    participant A4 as Session observation
    participant R1 as Runtime output adapter
    participant R2 as Session owner and store
    UI->>A4: session/observe for bound Session
    A4->>A4: Register attempt and start buffering
    A4->>R1: session/readSnapshot
    R1->>R2: Capture ordered immutable view and log boundary
    R2-->>R1: Epoch, W, B, active text and Run state
    R1->>R2: Read display history through B outside gate
    R2-->>R1: Recorded items through B
    R2-->>R1: New local updates continue after W
    R1-->>A4: Normalized updates enter recovery buffer
    R1-->>A4: Snapshot at W
    A4-->>UI: Snapshot plus observationId
    UI->>UI: Install complete base
    UI->>A4: session/ready with observationId, epoch, W
    A4->>A4: Drop updates through W; flush later suffix in order
    A4-->>UI: Buffered updates then live updates
    Note over R1,R2: Socket loss never blocks local view or history
```

## 5. Ordered work packages

- [ ] **D05-01 — Establish projection identities and fixtures.**
  Consume 01's schemas and 02's item associations. Add deterministic fixtures
  for text, multiple assistant items, tool calls/results, null legacy Run IDs,
  and accepted input before message commit. Define the projection mapping
  without changing provider SDK types or anything inside `packages/ai`.
  Exit: fixture IDs survive start, deltas, commit, and history reconstruction.

- [ ] **D05-02 — Add bounded display-history reads to R2.**
  Extend the existing store and facade-facing query contract with immutable
  committed-prefix access. Preserve physical message order across compaction.
  Exercise append-after-capture and deletion-during-read cases before R1 wiring.
  Exit: no returned item originates after B; old display messages remain visible.

- [ ] **D05-03 — Maintain and capture the Runtime view.**
  Add accumulated active text, item revisions, Run state, and uncommitted input
  under Session ordering. Capture them with B in one short operation.
  Route narrow snapshots through Agent without exporting Session/store objects.
  Exit: the active base and subsequent delta agree during a blocked history read.

- [ ] **D05-04 — Normalize and publish without network backpressure.**
  Wire R1 to the local view; validate outbound updates against P. Publish
  durable final items and settlement in 02's order. Use 03's bounded writer
  handoff and discard network enqueue attempts while disconnected.
  Exit: fake tools finish with both network writers deliberately stalled.

- [ ] **D05-05 — Implement A4 observation lifecycle.**
  Add both indexes, fresh IDs, deadlines, register-before-read buffering,
  exact ready validation, and ordered flushing before live delivery.
  Hook frontend close/unobserve and Session deletion into idempotent cleanup.
  Exit: two clients can observe independently without cross-Session delivery.

- [ ] **D05-06 — Fence recovery and enforce limits.**
  Invalidate attempts on epoch change, stale backend generation, buffer limit,
  install deadline, or revision failure. Request a new snapshot only after
  readiness and keep retries bounded by the connection lifecycle.
  Exit: no obsolete response/update can revive an invalidated observation.

- [ ] **D05-07 — Add deterministic race and failure suites.**
  Introduce explicit barriers at registration, capture, history read, ready,
  flush, durable commit, and settlement. Assert identities, text, revisions,
  queue sizes, execution counts, and saved records rather than timing sleeps.
  Exit: all T05 cases below have automated assertions and fixture ownership.

## 6. Failure cases and acceptance

All cases are planned tests using fake providers and temporary Agent Homes.
No test in this table has been executed by writing this document.

| ID | Trigger | Exact observable assertion |
| --- | --- | --- |
| T05-01 | Emit an update after A4 registration but before snapshot capture. | Its revision is included at or below W and is not delivered a second time after ready. |
| T05-02 | Commit the final item and settle after capture but before ready. | Snapshot has the earlier state; ready flush produces exactly one final item ID and the actual settled Run. |
| T05-03 | Settle immediately before capture. | Snapshot includes settled state and final item; buffer entries through W cause no duplicate terminal rendering. |
| T05-04 | Block the history read, then append another committed message. | Returned `items` excludes the later entry; a post-W update supplies it once. |
| T05-05 | Capture assistant text `abc`, then emit delta `def` during recovery. | Installed active item starts as `abc`; matching-base delta yields exactly `abcdef` under the same item ID. |
| T05-06 | Emit a new update while A4 flush is paused. | Frontend revision order remains W+1, W+2, W+3; live W+3 cannot overtake the buffered suffix. |
| T05-07 | Send ready with a wrong observation, epoch, or W. | Response is `OBSERVATION_EXPIRED`; no buffered suffix is released for that request. |
| T05-08 | Deliver a gap or delta with an unknown/wrong item base. | Current observation is invalidated before mutation; fresh snapshot is requested and text remains uncorrupted. |
| T05-09 | Repeat an update and then deliver an older observation's update. | Item text/revision changes once; obsolete observation contributes no rendered item or Run state. |
| T05-10 | Replace the backend link while an old snapshot response is delayed. | Old response is discarded; only an observation created against the ready replacement can become live. |
| T05-11 | Change view epoch during recovery. | Old ready fails; no delta from the new epoch is applied to an old-epoch item base. |
| T05-12 | Cross each recovery count/byte limit and the 30-second install deadline. | Attempt is freed and usable sockets receive `session/observationExpired` with `resyncRequired`; queues stay bounded and the Run continues. |
| T05-13 | Stall a frontend writer, including an expiry notification that cannot enqueue. | That connection closes without waiting for drain; a second observer receives later output and provider/tool completion count remains one. |
| T05-14 | Lose/stall the backend while the Run emits more than one queue limit. | Local text and durable history continue advancing; no outage-sized queue exists; reconnect snapshot restores current content. |
| T05-15 | Compact old messages, then observe/reopen. | Display history retains every recorded message in physical order; model context still uses the compaction summary. |
| T05-16 | Fail a final message's durable commit or terminal persistence. | No committed upsert or successful public settlement is announced for the failed transition; storage error/recovery state remains explicit. |
| T05-17 | Crash after durable acceptance but before user-message commit. | Recovery snapshot shows one interrupted Run and one `uncommittedInputs` entry; no invented committed user item or model restart occurs. |
| T05-18 | Crash after partial text but before its commit. | New epoch restores saved items only; lost partial text is not presented as durable and accepted nonterminal Run is interrupted. |
| T05-19 | Exceed 16 MiB snapshot encoding, including multibyte text. | `SNAPSHOT_TOO_LARGE` is returned with history unchanged; `run/read` still works and bounded `run/result` is independently usable. |
| T05-20 | Unobserve twice, close the last client, then subscribe again. | Both indexes/timers/buffers are empty; cleanup never waits for a dead socket, Run/listener survive, and reobserve restores the view. |
| T05-21 | Delete or replace captured storage while the bounded read is pending. | Read returns its valid captured prefix or an explicit error; it never succeeds with mixed or silently empty history. |
| T05-22 | Observe two Sessions with colliding local counters and legacy items. | Routing stays Session-scoped, legacy items retain `runId: null`, and no item is attributed to another Session/Run. |

## 7. Validation commands

Run existing package checks from the repository root after implementation:

```sh
npm run test -w @loopiq/agent -- src/session/agent-session.test.ts src/session/storage/jsonl-session-store.test.ts
npm run test -w @loopiq/server
npm run build
```

Add proposed test files `packages/agent/src/session/session-observation.test.ts`,
`packages/execution-host/src/session-observation/output-normalization.test.ts`,
and `packages/server/src/session-observation/session-observation.test.ts`.
They do not exist yet. Run them through the owning package test scripts once
03 has added the execution-host package/scripts; the current root test command
cannot establish coverage for a package or suite that has not been created.
Keep capture/flush barriers in test fixtures, outside the production protocol.

## 8. Migration and documentation updates

Update [architecture](../../architect.md), [Session persistence](../../session.md),
and [multi-Session runtime](../../techniquedocs/multi-session-runtime.md) with the
implemented projection owner, committed-prefix read, and local-versus-wire
snapshot distinction. Update [Agent runtime](../../techniquedocs/agent-runtime.md)
where public settlement or notification ordering changes.

Retain current direct CLI subscriptions while adding Runtime output adaptation.
Do not remove SSE solely because these tests pass; [06 cutover](./06-devui-migration-and-cutover.md)
owns browser equivalence, process acceptance, and old HTTP support messaging.
Publish numeric limits and explicit oversize recovery in operator/client docs.
Do not describe this plan as implemented until its tests and handoff are complete.

## 9. Completion checklist

- [ ] R2 captures W and B atomically with immutable active text and Run state.
- [ ] Display history preserves original messages behind model compaction.
- [ ] Stable item identity survives streaming, durable commit, and reload.
- [ ] A4 registers before capture and flushes before switching to live.
- [ ] Generation, epoch, view revision, item revision, and observation fences pass.
- [ ] Buffer, writer, install-time, and encoded-size limits have boundary tests.
- [ ] Network loss and zero observers leave healthy execution independent.
- [ ] T05-01 through T05-22 pass with evidence recorded in the implementation PR.
- [ ] Browser handoff includes schemas, failure signals, fixtures, and no automatic Run replay.
