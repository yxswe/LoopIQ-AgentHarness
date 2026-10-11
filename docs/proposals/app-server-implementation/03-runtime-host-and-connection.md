# Runtime Host and Connection

Status: Planned

## 1. Outcome and scope

Implement R1, the independent execution host, and A3, the app-server's connection
to that host. Runtime initiates one WebSocket shared by all Sessions and keeps
executing accepted work when the socket or app-server disappears.
The [consolidated design](../app-server-runtime-design.md) remains authoritative.

This stage supplies authenticated connection lifecycle, generation fencing,
request correlation, bounded delivery, and process ownership. It consumes the
durable facade from [02](./02-durable-session-execution.md); it does not recreate
acceptance records, recovery rules, or capacity accounting in a transport layer.
It exposes hooks for [04](./04-appserver-session-application.md) to reconcile the
catalog and for [05](./05-session-observation.md) to receive normalized updates.

There are two distinct milestones. A controllable inventory fixture can prove
authentication, the synchronizing state, replacement, and reconnection here.
That is transport evidence only. Production `runtime/status` may report `ready`
only after 04 successfully merges real inventory and durably commits its catalog.
Passing a fixture or receiving the initialization response is not full readiness.

No frontend migration, second Runtime implementation, automatic work queue,
provider setup UI, or execution retry policy belongs in this stage. Same-host
and remote-host deployment use the same contracts; configuration selects the
address and Runtime-local paths.

## 2. Prerequisites and source map

Read [architecture](../../architect.md), [Agent lifecycle](../../techniquedocs/agent-runtime.md),
[multi-Session ownership](../../techniquedocs/multi-session-runtime.md), and
[Session storage](../../session.md) before implementation.
[01](./01-protocol-contracts.md) supplies endpoint allowlists, validators, errors,
and limits. Stage 02 supplies durable submission, deletion, and Run query behavior.

| Current source | Evidence and required migration |
| --- | --- |
| [server.ts](../../../packages/server/src/server.ts) | Calls `createDefaultRuntime` during startup and routes directly to `Agent`; move execution ownership out of this process. |
| [runtime-factory.ts](../../../packages/server/src/runtime-factory.ts) | Calls `createAgent`, applies a default model, and opens/creates a browser Session; the host must not inherit implicit browser Session creation. |
| [agent.ts](../../../packages/agent/src/agent.ts) and [create-agent.ts](../../../packages/agent/src/create-agent.ts) | Keep the public facade and construction root; R1 imports their public entry, not engine or Session internals. |
| [agent-session-manager.ts](../../../packages/agent/src/session/agent-session-manager.ts) | Owns writer leases, loaded Sessions, and explicit shutdown; socket closure must not call that shutdown. |
| [session-store-lease.ts](../../../packages/agent/src/session/storage/session-store-lease.ts) | Exclusive `wx` creation records PID/time only; stale-owner recovery and process-start identity are missing. |
| [nodejs.ts](../../../packages/agent/src/env/nodejs.ts) and [bash.ts](../../../packages/agent/src/tools/bash.ts) | Shell execution creates process groups and supports background work; durable crash ownership is not established by existing abort handling. |
| [supervisor.py](../../../integrations/harbor/supervisor.py) | Contains evaluation-specific descendant cleanup; use as failure-test evidence, not as the Runtime lifecycle owner. |

Proposed placement is `packages/execution-host/` for the host executable and
`packages/server/src/execution-connection/` for A3. These paths are implementation
targets. Keep execution resource ownership inside its Agent subsystem; do not
add a repository-wide `runtime`, `services`, or `utils` folder.

Before transport integration, freeze the facade operations for inventory,
creation/deletion, `startRun`, `readRun`, `readRunResult`, `steerRun`, and `abortRun`.
They must return serializable contracts, not `RunHandle.result` promises on the wire.
Snapshot normalization is completed in 05; transport tests may use typed fixtures.

## 3. Contracts and invariants

### Identity and initialization

Persist one `runtimeServiceId` for the installation; generate `runtimeBootId`
once per process start. Reconnect preserves the boot ID and obtains a new link
generation. Existing Session bindings never transfer to another service ID.
Acquire the host-service lock before accepting work and retain per-Session
leases so direct CLI writers can still exclude the host for individual Sessions.

Connect to `/ws/runtime` and send `connection/initialize` with version, Runtime
token, service ID, and boot ID. The separate frontend token cannot authenticate
this endpoint. Reject unsupported versions, wrong credentials, and wrong service
identity before exposing ordinary backend methods. Redact secrets in diagnostics;
tokens never appear in URLs. Public connections use WSS; loopback development may use WS.

Initialization produces one success response and no `initialized` notification.
A3 then requests `runtime/inventory` while synchronizing. Inventory and response
dispatch must be usable in this state or readiness would deadlock. All ordinary
execution admission remains closed until 04 commits reconciliation for this link.
A callback completing an older generation cannot publish `ready` for a newer one.

### Replacement and liveness

| Condition | Required action |
| --- | --- |
| Same service and same boot reconnects | Replace the old socket, invalidate its pending calls and queued unadmitted commands, and synchronize again. |
| Same service but a different boot while old boot is live | Reject with `RUNTIME_ALREADY_CONNECTED`; do not steal the live link. |
| Different boot after old link closes or becomes stale | Admit a new generation, then reconcile; old responses remain invalid. |
| Unexpected service identity | Reject; retain persisted Session bindings and catalog evidence. |
| App-server exits or connection closes | Clear only connection resources; accepted Runtime work and local listeners continue. |

The accepting server sends WebSocket Ping every 15 seconds and closes the link
after 45 seconds without a matching Pong. Initialization expires after 10 seconds.
Runtime reconnects with jittered backoff from 1 to 15 seconds and resets it after
a stable ready period. Inject clocks and jitter in tests; interval values remain
configurable engineering defaults. Do not add a business RPC ping method.

### Dispatch and correlation

A3 allocates backend RPC IDs independently of frontend IDs. Pending entries bind
the backend attempt to its link generation and waiting caller, including
`clientConnectionId`/client RPC ID where applicable. Domain Session, submission,
Run, and deletion operation IDs pass through unchanged.

Resolve replies on the connection reader path before dispatching method handlers.
Initialization and control handling bypass Session mutation queues. Each admitted
handler runs asynchronously; neither the connection reader nor a Session gate
waits for model/tool execution or remote abort settlement. A blocked Session
cannot prevent another Session's RPC reply, heartbeat, or abort from progressing.

Exactly one result or error is generated for an accepted request attempt; delivery
may fail. Notifications have no response. Check generation before starting queued
work and before applying a response. Closing a link discards commands that have
not begun admission; work already durably accepted remains owned by R2.

An ordinary 30-second timeout detaches the waiter and releases its pending-map
entry. It does not cancel execution, reverse abort, or resend a mutation. A
forwarded request whose response is lost has an uncertain delivery outcome;
never manufacture `failed`, `aborted`, or a business rejection. Queries after
reconnect use the original domain identity and stage 02's durable records.

### Delivery and resource ownership

Bound each writer queue at 256 messages or 32 MiB, whichever comes first; reject
JSON messages over 32 MiB. Full snapshots/results retain their separate 16 MiB
bound. Exceeding backend delivery capacity closes the link and requires a fresh
synchronization. Do not block execution waiting for socket drain.

While disconnected, maintain local state/history and skip network enqueueing.
Do not accumulate an outage replay queue. R1's local event listener must perform
bounded local work and return independently of network delivery, because current
Session notification dispatch can await listeners. Stage 05 supplies the canonical
view; this stage supplies the nonblocking handoff and connection invalidation.

Process ownership uses the host-service lock plus Session writer leases, with
process-start identity to distinguish PID reuse. Reacquire only after proving
the previous owner dead and making the takeover atomic against competing starts.
Never unlink a live writer's lock. Ambiguous legacy locks require local cleanup.
R2 owns safe Session-log recovery; R1 supplies process and descendant evidence.

Record enough ownership to reconcile managed tool subprocess groups after a
Runtime crash, including background commands that intentionally outlive a Turn.
An app-server restart must not terminate those groups. A Runtime restart must
not accept affected Session work before cleanup is proved; otherwise return
`RECOVERY_REQUIRED`. Cleanup never reruns tools or promises workspace rollback.

## 4. Implementation flow

```mermaid
sequenceDiagram
    participant SUP as Independent launcher
    participant RT as R1 and Agent
    participant A3 as Runtime connection
    participant A2 as Session application
    SUP->>RT: Start and acquire host ownership
    RT->>RT: Recover safe Session and subprocess ownership
    RT->>A3: Open WS; connection/initialize
    A3-->>RT: Identity accepted; not execution readiness
    A3->>RT: runtime/inventory
    RT-->>A3: Complete inventory and tombstones
    A3->>A2: Reconcile for this link generation
    A2->>A2: Persist catalog merge
    A2-->>A3: Reconciliation committed
    A3-->>RT: runtime/status ready
    A3->>RT: run/start with stable submissionId
    RT-->>A3: Durable Run identity
    Note over A3: App-server is killed
    RT->>RT: Continue tool work and durable settlement
    RT->>A3: Reconnect after restart; same boot
    Note over RT,A2: Repeat inventory and catalog merge before ready
```

The stage-03 fixture substitutes a controllable reconciler for A2 and records
its calls. It may release a test-only readiness latch to exercise later transport
states, but that result must be labeled simulated readiness. The production
composition cannot install a no-op reconciler or mark itself ready on socket open.

## 5. Ordered work packages

- [ ] **D03-01 — Define the host/A3 dependency boundary.** Bind the protocol from
  01 to the durable facade from 02. Specify who supplies inventory and the
  generation-scoped reconciliation callback. Add fixtures that delay, fail, and
  complete it without constructing a frontend or reaching a real provider.
- [ ] **D03-02 — Add the independent executable.** Load Runtime identity, URL,
  connection secret, and local configuration; acquire the host lock, then create
  the Agent. Generate one boot ID. Construction must not pick a browser Session
  or perform provider login. Keep the launcher independent from server shutdown.
- [ ] **D03-03 — Establish safe process ownership.** Consume 02's process-start-aware
  Session leases; add the host-service lock and managed subprocess ownership/cleanup
  at the execution environment boundary. Report ownership safety to R2 so it
  admits no affected Session before reconciliation; keep log recovery in 02.
- [ ] **D03-04 — Implement backend admission.** Add `/ws/runtime`, endpoint-specific
  initialization and version checks, the 10-second deadline, and one-current-link
  state. Test identity mismatch and token redaction before routing Agent methods.
- [ ] **D03-05 — Implement generation fencing.** Distinguish same-boot replacement
  from competing live boots. Invalidate pending calls, queues, and recovery hooks
  on replacement. Tie every readiness completion to the generation that began it.
- [ ] **D03-06 — Implement asynchronous RPC routing.** Correlate responses before
  request handlers, retain stable domain IDs, and detach 30-second waiters without
  canceling work. Expose caller delivery classification separately from Run state.
- [ ] **D03-07 — Bound writers and outage behavior.** Track message count and encoded
  bytes, close on overflow, skip enqueueing while disconnected, and keep local
  subscriptions installed. Use blocked socket fixtures to prove commits continue.
- [ ] **D03-08 — Implement liveness and reconnect.** Add server control Ping/Pong,
  heartbeat expiry, bounded jittered reconnect, and stable-ready backoff reset.
  Reinitialize and request inventory after every reconnect, including same boot.
- [ ] **D03-09 — Integrate production reconciliation.** Replace the fixture with
  04's durable catalog merge. Publish `ready` only after that succeeds for the
  current generation; disconnect on failed synchronization as specified by design.
- [ ] **D03-10 — Prove process separation.** Kill app-server during a controllable
  tool invocation, restart it, and recover the same Run/result. Then kill Runtime
  to prove ownership cleanup and interrupted recovery without a second execution.
  Document the supported launcher/platform and explicit local shutdown behavior.

D03-01 through D03-08 form the handoff gate that allows 04 to start with a
controllable reconciler. D03-09 and D03-10 close this stage jointly with 04 at M2.
Neither stage waits for the other's full completion before that integration work.

## 6. Failure cases and acceptance

Use separate child processes, temporary Agent Homes, fake providers, observable
tool invocation counters, controllable sockets, and injected time. Fixtures must
expose admission/commit barriers so tests assert outcomes rather than rely on sleeps.

| Test | Trigger | Exact assertion |
| --- | --- | --- |
| T03-01 | Connect without initialization, with wrong endpoint token, or unsupported version. | No Agent command executes; the protocol returns the applicable initialization/auth/version error, and an uninitialized socket closes by its deadline. |
| T03-02 | Hold the fixture reconciler after valid initialization. | Exactly one initialize response is sent; ordinary execution returns `RUNTIME_SYNCING`; no production-ready claim is emitted. |
| T03-03 | Reconcile real inventory and commit catalog through 04; separately fail inventory or catalog fsync. | Only successful current-generation reconciliation emits `ready`; either failure leaves execution unavailable and preserves valid catalog evidence. |
| T03-04 | Open a same-boot replacement while an RPC and reconciliation are pending. | Old waiters become uncertain and are removed; old replies/readiness callbacks cannot mutate the new link; durable accepted work continues once. |
| T03-05 | Connect a different boot while the old boot answers heartbeats, then after it closes. | First attempt gets `RUNTIME_ALREADY_CONNECTED`; later attempt synchronizes as a new generation and cannot inherit old pending IDs. |
| T03-06 | Drop matching Pong responses with a fake clock. | Ping is sent at the configured 15-second interval; link is closed at 45 seconds without matching Pong; reconnect delay stays within configured jittered bounds. |
| T03-07 | Delay abort settlement and send another Session's query plus backend responses. | Reader/control handling and the second Session complete while abort waits; no Session or connection-wide gate spans that wait. |
| T03-08 | Lose a forwarded start/abort reply or advance the ordinary RPC timeout. | Pending entry is removed; caller receives uncertainty, no mutation is automatically repeated, and subsequent durable query returns the actual Run state/outcome. |
| T03-09 | Block socket writes past either writer-queue cap while a tool runs. | Queue never grows beyond the admission bound; link closes, tool and durable settlement progress, and no outage-event backlog accumulates. |
| T03-10 | SIGKILL app-server during a marked tool interval and restart it. | Runtime PID/boot ID stay unchanged; the tool completes once; real reconciliation restores availability and the original Run/result is queryable. |
| T03-11 | Start a second host, or open a Session held by a live direct CLI writer. | Host-service contention admits no second host; Session contention returns `SESSION_LOCKED` without removing the CLI lease or blocking unrelated Sessions. |
| T03-12 | Crash Runtime with managed descendants; simulate dead, live, PID-reused, and legacy lease records. | Only verified dead ownership is recovered atomically; affected ambiguous ownership yields `RECOVERY_REQUIRED`; live/unrelated processes and project files remain untouched. |
| T03-13 | Kill Runtime after acceptance and restart after safe cleanup. | Boot ID changes; accepted nonterminal Run is interrupted through 02; retained terminals remain unchanged; no provider/tool invocation restarts automatically. |
| T03-14 | Run the same suite with loopback and a separately addressed Runtime fixture. | Wire methods, binding, generation behavior, and results match; app-server never resolves Runtime workspace paths on its own machine. |

T03-02 is the early transport milestone. T03-03 and T03-10 require stage 04;
do not report them passed using only its fixture. Snapshot/live correctness is
covered by stage 05, and browser recovery/cutover by stage 06.

## 7. Validation commands

Existing commands, run from the repository root:

```sh
npm run test -w @loopiq/agent
npm run test -w @loopiq/server
npm run build
git diff --check
```

The current build covers AI, Agent, and CLI; it does not build a future host.
Existing server tests also do not prove WebSocket or process isolation behavior.
Do not use the mutating `npm run check` as a read-only documentation check.

Proposed commands, to add with implementation and keep aligned with package scripts:

```sh
npm run execution-host
npm run build -w @loopiq/execution-host
npm run test -w @loopiq/execution-host
npm run test:process -w @loopiq/execution-host
npm run test -w @loopiq/server -- src/execution-connection
```

The proposed root `execution-host` script delegates to workspace `start`, which
runs `bun run src/main.ts`. Start it independently from `devui`; stopping that
server command must not signal the host. Stage 06 uses the same launch convention.
These commands are not available in the current repository. The proposed process
suite must identify supported platforms, run T03-10 through T03-13 without paid
providers, and remove only its own temporary processes/files after each case.

## 8. Migration and documentation updates

Move Agent construction into the host; 04 isolates the new server composition
from any temporary legacy entry, which 06 removes. Do not import
`createAgentForTesting` into production to expose an arbitrary Agent Home option.
Keep the CLI's direct Agent entry and per-Session lease contention semantics.

Update `docs/architect.md`, `docs/techniquedocs/multi-session-runtime.md`,
`docs/techniquedocs/agent-runtime.md`, and `docs/session.md` alongside relevant
code changes. Record the actual host entry point, launch/stop instructions,
connection configuration, process-start identity mechanism, and recovery procedure.
Do not label stale-lock recovery implemented until platform crash tests pass.

Resolve and document the launcher/supervisor choice, operating-system process
identity mechanism, identity/config file placement, and stable-ready backoff
reset interval during implementation. These are open implementation choices;
they cannot weaken independent lifetime, exclusive ownership, or readiness rules.
Keep `packages/ai` read-only and keep provider secrets and SDK objects local.

## 9. Completion checklist

- [ ] R1 and A3 use one authenticated Runtime-initiated connection and protocol 01.
- [ ] Transport-fixture evidence is distinguished from production-ready evidence.
- [ ] Real inventory/catalog reconciliation from 04 gates every ready transition.
- [ ] Replacement, timeout, response dispatch, heartbeat, and queue tests pass.
- [ ] App-server loss preserves execution and restart recovers the original result.
- [ ] Runtime crash cleanup proves ownership before stage-02 interruption recovery.
- [ ] Direct CLI contention and concurrent Sessions retain their documented behavior.
- [ ] Stage 05 has bounded update delivery and generation invalidation hooks.
- [ ] Supported process platforms, new scripts, and architecture changes are documented.
