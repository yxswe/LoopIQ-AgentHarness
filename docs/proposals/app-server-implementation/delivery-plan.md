# App-server Delivery Plan and Acceptance Record

Status: In progress. Started 2026-10-11.

This is the single delivery tracker for the app-server/Runtime refactor: branch
workflow, small PRs, milestone acceptance, and evidence. The
[target design](../app-server-runtime-design.md) defines behavior; the
[implementation index](./README.md) and its six documents define detailed work
packages and automated acceptance. This tracker changes delivery granularity,
not their guarantees. [Architecture](../../architect.md) describes shipped code.

## 1. Branches and review cadence

- Integration branch: `codex/app-server-development`, based on main commit
  `43f8e3194b627de1d1d640183a0a20f349e26bc7`.
- Design baseline: `9cc7b8c` records the 12 existing proposal files unchanged.
  Those 4,860 lines are prior design input, not a new implementation PR.
- PR 00 adds this tracker. Implementation starts with PR 01. Both are separate
  review units; the first code PR may be stacked on the planning PR.
- Use `codex/app-server-<number>-<purpose>` branches. Target the integration
  branch after dependencies merge. A stacked PR targets its immediate parent
  so its diff contains only its own work; record that dependency in the PR.
- After the parent merges, update the child from the integration branch and
  retarget it. If the parent was squash-merged, rebase only the child's commits
  onto the new base. Preserve the reviewable diff; do not merge parent work twice.
- Deliver one new implementation PR per review cycle. Review and merging belong
  to the repository owner. Do not auto-merge or enable auto-merge. Independent
  planning and test-fixture work may proceed while review is pending.
- At each milestone, record developer verification separately from the owner's
  manual E2E result. Begin the next milestone after the owner records acceptance
  or explicitly chooses to proceed with a documented limitation.
- Keep `main` unchanged during development. After M4 acceptance, the owner can
  review an integration PR from the development branch to `main`.

## 2. What counts as a small PR

Each PR changes one observable behavior or one prerequisite contract. Include
its necessary tests and code-coupled documentation. Keep unrelated cleanup,
renames, dependency updates, and future optional features out of that diff.

Aim for 100–250 changed production lines and at most 500 manually authored
changed lines including tests/docs. These are planning targets, not incentives
to omit failure tests. Split a larger unit into suffixed IDs such as `09a/09b`
before implementation when it has separable behavior. For an indivisible change,
record the size and concrete reason in the PR. Report generated lockfile changes
and mechanical deletions separately; still inspect both.

Every PR description must state its tracker ID, purpose, dependency/base, scope,
commands actually run, discovered test count, limitations, and manual review
recipe. Explain any storage compatibility change. Update this tracker and the
affected source document's evidence record in the same PR. Update architecture
and linked subsystem docs when behavior, ownership, or APIs change.

A unit test does not prove process survival. A green empty test suite does not
prove coverage. Use fake providers and disposable data for failure tests. Keep
`packages/ai` read-only, including avoiding build commands that write its output.
Do not run the root mutating `npm run check` as verification.

## 3. Milestones

| Milestone | User-visible result | PRs | Design stages | Status |
| --- | --- | --- | --- | --- |
| M1 — Durable local execution | Query one accepted submission and its durable outcome after restart through a local acceptance client. | 01–12 | 01–02 | In progress |
| M2 — Independent service | Use a protocol client to manage Sessions and Runs; Runtime survives app-server loss. | 13–24 | 03–04 | Planned |
| M3 — Recoverable observation | Load saved/active output, disconnect, and recover exact current text and outcome. | 25–28 | 05 | Planned |
| M4 — Browser cutover | Perform the complete workflow in DevUI, including restart recovery and explicit legacy API failure. | 29–35 | 06 | Planned |

The first milestone uses a local test client and the next two use a protocol
client. Browser E2E arrives at M4. These are complete owner-operated journeys
through the available system boundary, not claims that the future UI exists.

### M1 PRs: contracts and durable local execution

| ID | Single review unit | Boundary and required verification |
| --- | --- | --- |
| 01 | RPC envelope package | Browser-safe package, request/response/notification validation, string request IDs and null error correlation; malformed and ambiguous envelope fixtures. No handlers. |
| 02 | Connection contract | Initialize payloads, version, direction rules, delivery classification, errors and byte limits. No sockets or authentication implementation. |
| 03 | Session and Run contracts | Lifecycle/Run method schemas, inventory and retained results; distinguish uncertainty, busy, accepted, and settled. |
| 04 | Observation contract and browser export | Item/snapshot/update/expiry schemas and browser consumption smoke test; close document 01's contract checklist. |
| 05 | Durable Session file format | Append/sync and atomic replacement, v2 migration/parser, torn-tail recovery; preserve legacy IDs/context and reject interior corruption. |
| 06 | Writer ownership | Process-start-aware leases, atomic takeover/release, live-writer and ambiguous-legacy rejection. |
| 07 | Stable Session creation | Immutable creation identity/defaults and authoritative inventory; invalid workspace/configuration cannot become ready. |
| 08 | Recoverable Session deletion | Durable intent/tombstone, restartable cleanup and ID reuse rejection; workspace files remain unchanged. |
| 09 | Durable Run admission | Duplicate-first lookup, fsynced acceptance and capacity reservation; no execution before acceptance or automatic resend. |
| 10 | Durable settlement and exact Run control | Persist/release before public terminal state; retained abort outcomes, stale control and steering semantics. |
| 11 | Retained output/result identity | Stable Run/item associations, final result lookup and committed-history boundaries; legacy and compaction correctness. |
| 12 | Lost-boot recovery and M1 walkthrough | Interrupt nonterminals without execution, exercise direct CLI compatibility, and deliver the M1 local acceptance fixture. |

Sources: [01 contracts](./01-protocol-contracts.md) and
[02 durable execution](./02-durable-session-execution.md). Each prerequisite
lands with its own fault tests; PR 12 assembles those fixtures into the manual
walkthrough. It does not defer durability testing until the end.

M1 proves R2's recovery barrier using explicit process-ownership evidence from
a fixture. Actual managed tool descendant cleanup belongs to PR 14. Keep that
limitation visible; M1 alone does not authorize a production independent host.

### M2 PRs: independent Runtime and Session application

| ID | Single review unit | Boundary and required verification |
| --- | --- | --- |
| 13 | Independent host bootstrap | Stable service identity, boot identity, host lock and independent launcher; no implicit browser Session or provider login. |
| 14 | Managed subprocess recovery | Record/reconcile Run and background process ownership; unsafe ownership blocks affected Session work. |
| 15 | Backend initialization | Endpoint authentication, same-boot replacement, competing-boot rejection and generation fencing. |
| 16 | Backend RPC dispatch | Independent request IDs, asynchronous responses, timeout uncertainty and stale reply rejection; abort waits never block readers. |
| 17 | Backend delivery and liveness | Bounded queues, control Ping/Pong, reconnect backoff and no outage backlog; execution continues under blocked delivery. |
| 18 | Durable catalog store | Serialized atomic commits, public metadata/private operation evidence and explicit load failure. No transcript. |
| 19 | Frontend RPC admission | Frontend token/version, endpoint allowlists, bounded writers and per-connection cleanup; no execution owner in server. |
| 20 | Catalog reads and naming | Binding-based metadata reads and durable offline rename; no Session loading or Runtime name authority. |
| 21 | Inventory reconciliation/readiness | Merge current-generation inventory into the real catalog; preserve names, missing evidence and pending operations. |
| 22 | Remote Session creation | Persist create intent, forward stable ID, reconcile lost replies and preserve Runtime-local cwd authority. |
| 23 | Remote Session deletion | Persist/query the operation, restore after busy rejection and remove catalog only after complete tombstone evidence. |
| 24 | Remote Run routing and M2 walkthrough | Route exact start/read/result/steer/abort identities; wire the new server entry and demonstrate survival across server SIGKILL. |

Sources: [03 host/connection](./03-runtime-host-and-connection.md) and
[04 application](./04-appserver-session-application.md). Transport work uses a
controllable reconciler until PR 21. Simulated readiness is test-only; the real
entry cannot report ready before the actual catalog commit. The new entry has
no reachable Agent/provider dependency. Any transitional legacy entry remains
explicitly isolated until PR 35 removes it.

### M3 PRs: snapshots and live observation

| ID | Single review unit | Boundary and required verification |
| --- | --- | --- |
| 25 | Ordered Runtime display view | Stable items, active text, Run states and revisions under Session ordering; no provider objects on the wire. |
| 26 | Immutable snapshot/history boundary | Capture view W and committed prefix B together; later appends/deletion cannot produce mixed or silently empty history. |
| 27 | Observation installation | Register before snapshot, exact ready handshake and ordered suffix flush; independent Session/client indexes. |
| 28 | Observation recovery and M3 walkthrough | Expiry, gaps, stale generations, overflow and reconnect; bounded client/server delivery and no resubmission. |

Source: [05 observation](./05-session-observation.md). Snapshot and delta race
tests land with PRs 25–27; PR 28 assembles the protocol-client E2E walkthrough.

### M4 PRs: browser workflow and cutover

| ID | Single review unit | Boundary and required verification |
| --- | --- | --- |
| 29 | Browser RPC connection | Shared protocol consumption, initialization, attempt correlation, timeout and reconnect lifecycle. |
| 30 | Browser catalog workflow | List/select/create/rename, Runtime-local cwd and persisted unresolved creation identity; offline behavior. |
| 31 | Browser Run submission recovery | Pre-send persistence, immutable submission IDs and same-ID queries/manual retry; one pending user bubble. |
| 32 | Browser observation rendering | Install snapshots and merge exact item/revision bases; late replies cannot overwrite a different selection. |
| 33 | Browser Run controls | Exact-target steer/abort, stopping and uncertainty states, actual outcome after completion races abort. |
| 34 | Browser permanent deletion | Persist delete operation, recover after reload, preserve workspace and display busy/offline/pending states. |
| 35 | Process cutover and M4 walkthrough | Verify new workflows before removing legacy paths/dependencies; HTTP 410 support boundary, independent launch and operator guide. |

Source: [06 cutover](./06-devui-migration-and-cutover.md). Add browser acceptance
fixtures incrementally in PRs 29–34. PR 35 must show equivalence before legacy
removal and rerun those journeys afterward. Split mechanical legacy removal
into `35b` if its review would obscure changed behavior.

## 4. Owner-operated E2E acceptance

The commands below are planned deliverables, not existing commands. Before a
milestone becomes `Ready for user E2E`, its final PR must implement the matching
walkthrough and replace any provisional instruction here with exact verified
commands, paths, URLs, and platform requirements.

Planned entry: `npm run acceptance:app-server -- M1` (or `M2`, `M3`, `M4`). The
entry supplies an interactive walkthrough, not just a hidden test-suite run.
It prints the temporary data locations, process IDs, connection addresses,
operator actions, observed state, and evidence output directory. Provide a
cleanup command that removes only the fixture's processes and temporary data.

Use deterministic fake providers and controllable tools. Fault switches belong
to local test fixtures at IO/process boundaries, never production RPC methods.
The harness must not modify `~/.loopiq`, existing project files, or real
credentials, and must not add a public arbitrary-Agent-Home override solely
for testing. If safe isolation is unavailable, the walkthrough is not ready.

For every walkthrough, retain an evidence bundle containing the tested commit,
OS/runtime versions, exact commands, RPC/Run/item identities, invocation counts,
redacted logs, and the owner's pass/fail notes. A generated trace proves what
ran; only the owner's explicit result marks manual acceptance passed.

### M1 — Durable local execution

Setup: launch the local fixture with two Sessions, a workspace marker, a
barrier-controlled fake provider and visible append/settlement counters.

| Owner action | Pass condition |
| --- | --- |
| Start one submission; repeat it unchanged, then repeat it with changed text. | Original identity is returned without another invocation; changed text conflicts. |
| Pause acceptance sync, inspect counters, then release it. | No provider/tool starts before durable acceptance; one starts afterward. |
| Start a distinct submission in the busy Session, then fill four Sessions and attempt a fifth. | Busy/capacity rejection creates no accepted record or waiting task. |
| Steer the exact Run; abort it and immediately start another. | Steering stays in its Run; abort returns actual terminal outcome after reservation release. |
| Kill the fixture after acceptance; restart against its disposable store. Repeat after durable settlement. | First Run becomes interrupted with no invocation replay; saved terminal remains unchanged. |
| Inspect an old-format history, then delete an idle Session. | Legacy IDs/messages remain readable; deletion retains a tombstone and preserves the workspace marker. |
| Run the fixture's fresh/resume CLI compatibility recipe without app-server. | Existing machine schema and one completion record remain correct. |

Gate: all rows pass, T01/T02 evidence is recorded, and the real-descendant
limitation is stated. Exact launcher/cleanup commands: pending PR 12.

### M2 — Independent service

Setup: launch separate app-server and Runtime processes plus the protocol client.
Print both PIDs, Runtime boot ID and the catalog path. Use no browser prerequisite.

| Owner action | Pass condition |
| --- | --- |
| Connect with the wrong token; then hold real inventory/catalog commit. | No unauthorized operation; valid initialization remains syncing until commit succeeds. |
| Create a Session and rename it; disconnect Runtime and repeat list/rename/create/start/delete. | Saved list/rename work; new remote mutations reject and never replay on reconnect. |
| Run two Sessions in the same workspace and hold one abort response. | Other Session commands/replies continue; context differs while files are shared. |
| Kill only app-server during a marked tool operation; restart it. | Runtime PID/boot ID stay unchanged; tool finishes once and original result is queryable. |
| Drop an accepted start reply, then query its original submission after reconnect. | One accepted Run and one invocation exist; timeout was never shown as failure. |
| Lose create/delete replies and restart app-server. | Original identities reconcile; catalog removal requires completed Runtime deletion; workspace survives. |
| Crash Runtime with a managed child, restart, and also try a competing live owner. | Ownership is reconciled before new work; nonterminals interrupt; no live writer is stolen. |
| Repeat with Runtime on a separate host/container and a directory absent on app-server. | Same protocol works and cwd is validated only by Runtime. Record the exact environment used. |

Gate: actual 03+04 readiness/process evidence passes, including descendant
cleanup on each claimed platform. A loopback-only run does not pass the remote
row. Exact launcher/cleanup commands: pending PR 24.

### M3 — Recoverable observation

Setup: use two protocol observers and a fake streaming Run with explicit
`abc`/`def` output barriers, snapshot capture/ready barriers and queue meters.

| Owner action | Pass condition |
| --- | --- |
| Capture `abc`, produce `def`, then install snapshot and send ready. | One stable item contains exactly `abcdef`; suffix never precedes its base. |
| Complete a Run between capture and ready; repeat with completion before capture. | Exactly one final item and the actual terminal state appear in both cases. |
| Disconnect either observer and then the backend; reconnect each. | Fresh observation restores current text/history; execution count remains one. |
| Overflow one observer or miss ready deadline; keep the second observer healthy. | Explicit expiration/closure and fresh snapshot; bounded buffers; healthy observer continues. |
| Feed a stale epoch/revision/base; observe compacted and oversized histories. | Invalid deltas cannot corrupt text; old recorded messages remain; oversize returns explicit error and preserves data. |
| Remove the last observer while work continues, then observe again. | Run and Runtime listeners survive; results recover without a new submission. |

Gate: T05 races pass and manual traces establish snapshot/live ordering.
Exact launcher/cleanup commands: pending PR 28.

### M4 — Browser cutover

Setup: open the fixture DevUI URL in two browser tabs with isolated test storage.
Use the independently launched services and deterministic provider from M2/M3.

| Owner action | Pass condition |
| --- | --- |
| Create/select/rename Sessions and enter an existing Runtime directory. | Catalog persists; creation starts no model call; selection never mixes histories. |
| Submit text, lose each hop's acknowledgment, then reload. Try a negative lookup/manual retry. | Original submission is queried; one input bubble/Run exists; retry preserves immutable ID/text. |
| Make pending storage fail before sending. | Composer keeps text and no start frame is sent. |
| Stream, switch Sessions, reload, close the last tab, and reopen. | Active bases and final outcomes recover; stale callbacks never change the new selection. |
| Steer with a lost reply and abort while normal completion races. | Steering uncertainty remains visible without resend; exact Run shows actual outcome. |
| Delete busy/offline/idle Sessions and reload during deletion. | Busy/offline reject; idle cleanup converges by operation ID; project marker remains. |
| Kill app-server and then Runtime at the fixture's acceptance/settlement barriers. | Server loss preserves execution; Runtime loss interrupts only unfinished work; no automatic tool replay. |
| Request oversize history, an old HTTP API, and run the old control tool. | Explicit size error; HTTP 410 `LEGACY_HTTP_UNSUPPORTED`; old tool exits nonzero with documented unsupported status. |
| Follow clean-checkout launch instructions and the direct CLI recipe. | Two independent services start; current CLI works locally; no hidden legacy Agent fallback. |

Gate: all AC-01–AC-24 requirements and T06 cases have developer evidence;
owner passes this walkthrough and M2's remote-host row on the release candidate.
Exact browser/launcher/cleanup commands: pending PR 35.

## 5. Progress and evidence

PR states: `Planned`, `In progress`, `In review`, `Merged`. Milestone states:
`Planned`, `In progress`, `Ready for user E2E`, `Accepted`. PR merge alone does
not imply manual acceptance. Rows without an evidence entry remain Planned.

| ID | State | Branch / PR | Evidence and next action |
| --- | --- | --- | --- |
| Baseline | Recorded | `codex/app-server-development` / `9cc7b8c` | Existing proposals committed unchanged; no implementation claim. |
| 00 | In review | [#9](https://github.com/yxswe/LoopIQ-AgentHarness/pull/9), `codex/app-server-delivery-plan` | 284-line tracker and index link; local links, code fences and whitespace checks passed. |
| 01 | Planned | `codex/app-server-01-rpc-envelopes` | First code slice; only the RPC envelope/package boundary. |
| 02–35 | Planned | Not created | Follow the dependency tables; split IDs if review size requires it. |

Append one short entry for each delivered PR: number/URL and base; code/test
paths; exact commands/results/test count; affected Dxx/Txx/AC IDs; documentation
updates; limitations; next usable interface. Link evidence rather than pasting
long logs. Keep the source execution checklists consistent with this tracker.

For each milestone append:

```text
Milestone / tested commit:
Developer evidence / command output:
Manual environment (OS, runtime, same-host or remote):
Exact setup / walkthrough / cleanup commands:
Owner result and date (Pending until explicitly supplied):
Failed rows / known limitations / follow-up PRs:
Decision: Accepted / repeat E2E / explicitly proceed with recorded limitation
```

All owner acceptance results are currently Pending. O1–O5, archive/forks,
multi-Runtime scheduling, automatic worktrees and execution replay remain
outside this delivery plan. Any later scope change must update this tracker
and the authoritative design before dependent implementation starts.
