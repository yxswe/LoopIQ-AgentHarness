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
| 02a | Initialization and directions | Endpoint-specific initialize payloads, version, success/status distinction and method direction rules. No sockets or authentication implementation. |
| 02b | Delivery, errors and bounds | Delivery classifications, protocol/business errors and UTF-8 byte limits; keep uncertainty separate from execution failure. |
| 03a | Run contracts | Start/read/steer/abort/result schemas and retained display items; distinguish uncertain delivery, busy rejection, accepted work and settled outcomes. |
| 03b | Session lifecycle and catalog contracts | Session method schemas, public catalog/availability and authoritative inventory/deletion evidence. |
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

PR 02 was split before implementation on 2026-10-14 so initialization/direction
review stays separate from delivery/error/size semantics. The original scope
and milestone gates are unchanged; 02b follows 02a before PR 03.

PR 03 was split before implementation on 2026-10-14. Run contracts (03a) and
Session/catalog/inventory contracts (03b) have separate owners and fixtures.
03a includes the history item shape needed by retained results; PR 04 reuses it
for snapshots/updates and completes directional method maps and browser delivery.

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
| 00 | Merged | [#9](https://github.com/yxswe/LoopIQ-AgentHarness/pull/9), `codex/app-server-delivery-plan` | Squash-merged into the development branch as `dc01155` on 2026-10-11; document checks passed. |
| 01 | Merged | [#10](https://github.com/yxswe/LoopIQ-AgentHarness/pull/10), `codex/app-server-01-rpc-envelopes` | Squash-merged into the development branch as `bdfc71f` on 2026-10-14. |
| 02a | Merged | [#11](https://github.com/yxswe/LoopIQ-AgentHarness/pull/11), `codex/app-server-02a-initialization` | Squash-merged into the development branch as `d7bbfd7` on 2026-10-14. |
| 02b | Merged | [#12](https://github.com/yxswe/LoopIQ-AgentHarness/pull/12), `codex/app-server-02b-errors-and-bounds` | Squash-merged into the development branch as `b30894f` on 2026-10-14. |
| 03a | In review | [#13](https://github.com/yxswe/LoopIQ-AgentHarness/pull/13), `codex/app-server-03a-run-contracts`, base `codex/app-server-development` | Developer verification passed; owner review pending. |
| 03b–35 | Planned | Not created | Follow the dependency tables; split IDs if review size requires it. |

Append one short entry for each delivered PR: number/URL and base; code/test
paths; exact commands/results/test count; affected Dxx/Txx/AC IDs; documentation
updates; limitations; next usable interface. Link evidence rather than pasting
long logs. Keep the source execution checklists consistent with this tracker.

### PR 01 developer evidence (2026-10-11)

Implementation commit: `c6700db` (originally tested as `3a3bba0`); review: PR #10,
base `codex/app-server-development`. PR #9 was squash-merged as `dc01155`.
Only PR #10's two commits were rebased; `git range-diff` confirmed both patches
unchanged and a tree comparison found no content change before this tracker
update. Existing test evidence still applies; tracker-only changes add no code.

Code: `packages/app-protocol/src/{rpc,index}.ts`; tests: `src/rpc.test.ts`.
Validation: `npm run test -w @loopiq/app-protocol` discovered/passed 38 tests;
`npm run typecheck -w @loopiq/app-protocol`, `npm run build -w @loopiq/app-protocol`
and `npx --no-install biome check packages/app-protocol/src` passed.
`npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
updated only the new workspace's lock entries. `git diff --check` passed.

Browser-target build command:

```sh
bun build ./packages/app-protocol/src/index.ts --target=browser --outfile=/tmp/loopiq-app-protocol-browser.mjs --metafile=/tmp/loopiq-app-protocol-browser-meta.json
```

The bundle was evaluated with `node --experimental-vm-modules --input-type=module`
using `SourceTextModule` and `createContext({ TextEncoder, TextDecoder })`.
The linker rejected external imports. A request parsed as `request` and `[]`
as `invalid`; metadata contained no Agent/provider or external imports.
This proves a bundle boundary, not real-browser E2E. Verification used Node
25.4.0 and Bun 1.3.10.

Partial D01/T01 coverage is recorded in document 01. Architecture and the package
README describe the slice. Endpoint/domain validation and size enforcement are
next; existing adapters still use REST/SSE. The root build and runtime regression
suites were not run for this isolated package slice; the root build writes into
the read-only `packages/ai` dependency. No milestone or manual E2E is complete.

### PR 02a developer evidence (2026-10-14)

Implementation: `2662d98`; review: [#11](https://github.com/yxswe/LoopIQ-AgentHarness/pull/11),
base `codex/app-server-development` at `bdfc71f` after PR #10 merged. The local
development branch was fast-forwarded to that commit; no PR #10 commits were
replayed. The follow-up tracker change only records the implementation commit
and PR link; it changes no tested code.

Code: `packages/app-protocol/src/{connection,index}.ts`; fixtures:
`src/connection.test.ts`. The package now fixes version 1, initialization/status
shapes and direction/kind permission. Existing adapters do not consume it.

Validation from the repository root:

- `npm run test -w @loopiq/app-protocol`: 80 tests passed in two files.
- `npm run test -w @loopiq/app-protocol -- src/connection.test.ts`: all 42 new
  fixtures passed; this is the focused manual review recipe.
- `npm run typecheck -w @loopiq/app-protocol` and
  `npm run build -w @loopiq/app-protocol`: passed.
- `npx --no-install biome check packages/app-protocol/src`: passed.
- `git diff --check`: passed; all 106 local links and code fences in the five
  changed Markdown files passed validation.

Browser-target command:

```sh
bun build ./packages/app-protocol/src/index.ts --target=browser --outfile=/tmp/loopiq-app-protocol-02a-browser.mjs --metafile=/tmp/loopiq-app-protocol-02a-browser-meta.json
```

`node --experimental-vm-modules --input-type=module` imported the compiled ESM
package and checked Runtime/frontend initialization fixtures. It also evaluated
the bundle through `SourceTextModule` in `createContext({ TextEncoder, TextDecoder })`
with an import-rejecting linker: initialization parsing, readiness notification
direction, frontend notification rejection and batch rejection passed. Bundle
metadata contained no Agent/provider or external imports. Node 25.4.0, Bun 1.3.10.
This is bundle/VM evidence, not an actual browser or network E2E.

Partial D01-02/D01-03/D01-05 and T01-01/T01-02/T01-03/T01-08 support AC-01/AC-02;
no full acceptance case is closed. Architecture, package README and document 01
describe the slice. No speculative dispatcher or injection boundary was added.
Authentication/readiness enforcement, business payloads and sockets remain
planned. PR 02b is next. Root build and Agent/CLI regressions were not run for
this isolated contract addition; `packages/ai` stays read-only. Owner M1 E2E is Pending.

### PR 02b developer evidence (2026-10-14)

Implementation: `4c3d021`; review: [#12](https://github.com/yxswe/LoopIQ-AgentHarness/pull/12),
base `codex/app-server-development` at `d7bbfd7` after PR #11 merged. The
development branch was fast-forwarded; no merged feature commits were replayed.
The follow-up tracker change only records the implementation commit and PR link;
it changes no tested code.

Code: `packages/app-protocol/src/{rpc,connection,limits,index}.ts`. Co-located
tests cover strict errors, caller delivery classification and UTF-8 bounds.
`tsconfig.json` adds standard Web API types for `TextEncoder`; Node types remain
excluded. No production adapter currently consumes these contracts.

Validation from the repository root:

- `npm run test -w @loopiq/app-protocol`: 143 tests passed in three files (63 new).
- `npm run typecheck -w @loopiq/app-protocol` and
  `npm run build -w @loopiq/app-protocol`: passed.
- `npx --no-install biome check packages/app-protocol/src`: passed.
- `git diff --check`: passed. All 23 business reasons matched target design 5.2.
  The five changed Markdown files passed all 108 local-link and code-fence checks.

Browser-target command:

```sh
bun build ./packages/app-protocol/src/index.ts --target=browser --outfile=/tmp/loopiq-app-protocol-02b-browser.mjs --metafile=/tmp/loopiq-app-protocol-02b-browser-meta.json
```

`node --experimental-vm-modules --input-type=module` verified compiled ESM error
and delivery schemas. The bundle loaded through `SourceTextModule` in
`createContext({ TextEncoder, TextDecoder })`, with an import-rejecting linker.
Emoji input at/above 64 KiB, oversized multibyte parsing and failure-envelope
parsing passed; metadata excluded Agent/provider and external imports. Node
25.4.0, Bun 1.3.10. This is bundle/VM evidence, not browser or network E2E.

Partial D01-02/D01-05 and T01-01/T01-02/T01-06/T01-07/T01-08/T01-09 support
AC-01/AC-02/AC-09/AC-22. Architecture, package README and document 01 describe
the slice. The parser's 32 MiB guard is active; 64 KiB input and 16 MiB response
checks are shared helpers awaiting handlers. Classification decisions and timers
remain with future connection owners. Root build and Agent/CLI regressions were
not run for this isolated protocol change; `packages/ai` stays read-only.

Manual review: run the package tests, inspect the error and delivery fixtures,
then compare the `limits.test.ts` cases one byte below/at/above each default.
No server is needed. Owner M1 E2E is Pending; PR 03 is next.

### PR 03a developer evidence (2026-10-14)

Implementation: `083213a`; review: [#13](https://github.com/yxswe/LoopIQ-AgentHarness/pull/13),
branch `codex/app-server-03a-run-contracts`, base `codex/app-server-development`
at `b30894f` after PR #12 merged. The local development branch was fast-forwarded;
no merged feature commits were replayed. The tracker follow-up only records
the implementation SHA and PR link; tested code is unchanged.

Code: `packages/app-protocol/src/{run,history,index}.ts`; fixtures: `src/run.test.ts`.
Five Run method contracts cover exact identities, lookup uncertainty, terminal
outcomes and retained display results. No current adapter consumes them.

Validation from the repository root:

- `npm run test -w @loopiq/app-protocol`: 217 tests passed in four files (74 new).
- `npm run typecheck -w @loopiq/app-protocol` and
  `npm run build -w @loopiq/app-protocol`: passed.
- `npx --no-install biome check packages/app-protocol/src`: passed.
- `git diff --cached --check` and 109 changed-Markdown local-link/code-fence checks: passed.

Browser-target command:

```sh
bun build ./packages/app-protocol/src/index.ts --target=browser --outfile=/tmp/loopiq-app-protocol-03a-browser.mjs --metafile=/tmp/loopiq-app-protocol-03a-browser-meta.json
```

`node --experimental-vm-modules --input-type=module` validated compiled ESM
Run schemas, then loaded the bundle through `SourceTextModule` with only standard
Web globals and an import-rejecting linker. Run exports and response parsing
passed; metadata contained no Agent/provider or external imports. This is
bundle/VM evidence, not browser E2E.

Partial D01-03/04/05 and T01-01/02/03/05/06/08/09 support AC-01/02/05/07/08/09/16;
none of the execution guarantees is implemented by a schema. Architecture,
package README and document 01 describe the slice. Root build and Agent/CLI
regressions were not run for this isolated addition; `packages/ai` stays read-only.

Manual review: run `npm run test -w @loopiq/app-protocol -- src/run.test.ts`,
then compare the five method schemas with the README's success meanings.
Owner M1 E2E is Pending. PR 03b (Session/catalog/inventory) is next.

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
