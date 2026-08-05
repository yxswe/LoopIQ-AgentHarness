# Server and UI Design Review

Status: Evidence-audited review draft; not accepted architecture

Last audited: 2026-08-02 against committed `HEAD` `197bbf1`

## Purpose and Evidence Rule

This document records the current Server baseline, verified problems, accepted
design decisions, and decisions that still require review. It is not an
implementation specification.

Only committed code is evidence of current behavior. Deleted experiments,
uncommitted prototypes, and proposed endpoints are not implementation facts.
Forward-looking statements are explicitly marked **Accepted direction** or
**Open decision**.

The evidence inspected for this review is:

- `packages/server/src/server.ts`;
- `packages/server/src/runtime-factory.ts`;
- `packages/server/src/provider-credential-jobs.ts` and its tests;
- `packages/devui/public/app.js` and `index.html`;
- the public `Agent` interface and Session/event contracts;
- `docs/architect.md`, `docs/techniquedocs/multi-session-runtime.md`, and
  roadmap item 10.

## Current Committed Baseline

`@loopiq/server` is currently a DevUI backend, not a reviewed product Server.
It constructs one `Agent`, selects or creates one browser Session during
startup, serves the static DevUI, and exposes HTTP/SSE routes directly from one
`Bun.serve()` request handler.

Current behavior includes:

- configuration read/update;
- Provider listing and model listing;
- Provider credential add/remove through asynchronous credential jobs;
- Session list/create/get/update/delete;
- Run start, steering, and abort;
- live Session event SSE;
- static DevUI delivery;
- `/api/runtime` discovery containing a Server-selected
  `defaultSessionId`.

Current behavior does not include:

- a product UI;
- a public transcript-reading API;
- Session event replay or cursor/gap handling;
- historical Run lookup or retained Run snapshots;
- a reviewed Server shutdown sequence;
- structured request diagnostics;
- real-process Server integration tests or browser tests.

The current credential-job implementation retains its own authentication
events and terminal result for five minutes. This is authentication-job replay,
not Session event replay.

## Audit of the Previous Findings

| ID | Audit result | Evidence-based conclusion |
| --- | --- | --- |
| S-001 | Confirmed | Startup selects or creates a browser Session, `/api/runtime` publishes it, and deletion of that Session is rejected. This is a DevUI presentation choice owned by Server. |
| S-002 | Confirmed, correction was over-specified | `server.ts` mixes process startup, routing, validation, error mapping, two SSE transports, static files, and most HTTP capabilities. The previous fixed target folder tree was not justified by current callers and is removed. |
| S-003 | Confirmed | Values submitted in response to secret or manual-code prompts pass transiently through Server before reaching the Agent interaction callback. |
| S-004 | Partially confirmed | Current Bun reports `localhost` when no hostname is provided, so the earlier implication that the Server currently listens on every interface was unsupported. The real browser-security issue is wildcard CORS and the absence of an Origin policy. |
| S-005 | Confirmed | Request parsing and validation are handwritten and inconsistent; error mapping does not exhaustively map stable Agent error codes to HTTP meanings. |
| S-006 | Confirmed as complexity, not as a correctness bug | Credential jobs have IDs, SSE, replayed events, prompt IDs, listeners, cancellation, and retention. A simpler Auth Flow has been accepted as a target, but it is not implemented. |
| S-007 | Confirmed gap; previous solution rejected | No public recovery protocol exists. The deleted 512-event buffer, 100-Run retention, transcript endpoint, and cursor protocol are not current behavior or accepted defaults. |
| S-008 | Future risk only | There is no product UI and no accepted recovery protocol, so duplicate recovery implementations cannot be reported as an observed problem. |
| S-009 | Partially confirmed | There is no explicit JSON body limit or browser hardening-header policy. The previous document mixed these facts with nonexistent transcript/upload/product-UI behavior and did not prove a static path traversal vulnerability. |
| S-010 | Confirmed | Server diagnostics currently consist primarily of one startup log. |
| S-011 | Local artifact, not architecture | An ignored `packages/server/.data/credentials.json` exists in this workspace but is not read by current Server code. Its presence is a local cleanup matter, not a canonical runtime property. Its contents were not inspected. |
| S-012 | Confirmed | The only Server test covers `ProviderCredentialJobs`; there is no spawned-process protocol suite or browser test. |

## Confirmed Problems

### S-001: Server owns the DevUI's initial Session choice

`createDefaultRuntime()` finds or creates a Session for the launch Workspace.
`/api/runtime` exposes that Session as `defaultSessionId`, and the delete route
protects it from deletion.

This does not prevent an arbitrary HTTP client from calling explicit Session
routes. The narrower problem is that starting the Server mutates Agent state and
the Server owns a browser presentation choice.

**Open decision:** define how a future UI discovers, selects, resumes, or
creates a Session. Until that decision is made, `/api/bootstrap` and any
replacement payload are proposals only.

### S-002: The main Server module mixes unrelated transport capabilities

`server.ts` currently owns process configuration, Agent/runtime startup,
response helpers, error mapping, validation, Provider routes, configuration
routes, Session/Run routes, Session SSE, credential-job SSE, static delivery,
and listener startup.

The issue is change coupling and reviewability, not file length by itself.

**Accepted direction:** when Server work resumes, keep `server.ts` as the
composition boundary and extract only stable, present capabilities that are
actually being changed. Organize extracted files by business ownership such as
Provider authentication or Session transport. Do not pre-create a
controller/service/repository hierarchy or generic `runtime`, `services`, or
`utils` folders.

No exact target file tree is accepted yet.

### S-003: Server is inside the transient credential path

The current Agent API asks an adapter-provided interaction to answer prompts.
The credential-job response endpoint receives the submitted string and resolves
that interaction. API tokens and manual authorization codes can therefore be
present in Server request memory.

Required invariant for any replacement protocol:

- never log or persist submitted values;
- never replay, cache, or return submitted values;
- never include them in errors or structured diagnostics;
- retain them only long enough to forward the active interaction response;
- let Agent validate and persist the resulting credential.

This is a trust-boundary clarification. It does not move credential ownership
or Provider-specific authentication mechanics out of Agent and `@loopiq/ai`.

### S-004: Browser-origin policy is permissive

The current code supplies `Access-Control-Allow-Origin: *` and accepts browser
requests without checking `Origin`. A page served by another origin can
therefore attempt to call the local Server from the user's browser and, when
the CORS exchange succeeds, read responses.

The current Bun version reports `localhost` for this Server because no hostname
is supplied. The implementation nevertheless relies on that runtime default
instead of declaring its local-only boundary explicitly.

**Open decision:** Origin policy depends on how the future product UI connects:

1. if UI and API share an origin, emit no CORS permission and reject foreign
   browser origins;
2. if a separately served UI is required, allow only its exact configured
   origin;
3. do not retain wildcard CORS for credential-bearing or mutating APIs.

Remote access, authentication, TLS, and multi-user authorization are outside
the current local single-user design and require a separate proposal.

### S-005: HTTP validation and error mapping can drift

Examples in the current routes include:

- Session `thinkingLevel` values are cast without the explicit validation used
  by the configuration route;
- `providerRequest` is passed through after only checking that it is an object;
- malformed JSON sometimes becomes `null` and sometimes becomes `{}`;
- only a few `AgentRuntimeError` codes receive specific statuses, while other
  not-found, argument, authentication, storage, and unknown cases collapse into
  broad 400 or 500 responses.

**Accepted direction:** Server owns explicit wire validation and an exhaustive
mapping from stable Agent errors to HTTP responses. Keep this small and local;
do not add a schema framework or generated client before real protocol size and
consumer count justify it.

### S-006: Credential jobs are heavier than the accepted authentication target

The current credential protocol is functional, but it exposes a general job
system with event history and SSE. The supported interaction shape can be
represented with ordinary requests and one short-lived OAuth flow.

The accepted replacement direction is described in
[Provider Authentication Target](#provider-authentication-target). It remains
unimplemented and must not be described as current behavior.

### S-007: UI recovery has no public contract

`Agent.subscribe()` registers only a live listener. The current Server exposes
only that live stream. `Agent.getSession()` returns configuration and lifecycle
state, not messages. Consequently, a late or reconnected browser can miss
events and has no public way to rebuild the conversation.

This gap is also tracked by roadmap item 10, which requires the Agent event
delivery contract to be designed before Server SSE can offer reliable resume.

No recovery solution is accepted yet. In particular, the following remain
independent decisions:

- whether Agent exposes a durable transcript projection;
- whether current-runtime recovery uses bounded replay or a pre-registered
  run-scoped stream;
- cursor identity, gap detection, and ordering boundaries;
- whether historical Run status is needed in addition to transcript messages;
- what survives Agent or Server restart;
- pagination and memory limits.

Server must not answer these questions by parsing Session JSONL directly.

### S-009: HTTP limits and browser hardening are incomplete

Current JSON routes do not enforce an explicit body-size limit. Static DevUI
responses do not apply a reviewed browser security-header policy. Static path
construction also has no explicit resolved-path containment check, although
the previous draft did not establish an exploitable traversal through Bun's
normalized URL path.

These gaps should be addressed before accepting image uploads, a product UI,
or any non-loopback mode. Transcript pagination and upload limits are not
current defects because those endpoints do not exist; they belong to the design
of those future capabilities.

### S-010: Operational diagnostics are minimal

The Server prints one startup line but does not produce structured information
about request duration/result, Session or Run identity, SSE disconnect and
backpressure, or authentication phases.

Any diagnostics must exclude prompts, model content, tool results, submitted
credential values, authorization headers, cookies, and sensitive
authorization URLs.

### S-012: The HTTP and browser contracts are untested

`provider-credential-jobs.test.ts` verifies only the in-memory credential-job
state. It does not start the Server. There are no tests for route validation,
SSE behavior, static delivery, process shutdown, or the browser DevUI.

Tests for hypothetical bootstrap, transcript, replay, Run query, or product UI
routes must wait until those contracts are accepted. Current routes can receive
focused real-process coverage independently.

## Provider Authentication Target

Status: Accepted direction; not implemented

Provider-specific OAuth and API-token mechanics remain in `@loopiq/ai`. Agent
continues to own method advertisement, authentication execution, candidate
credential validation, and persistence after successful validation. Server
only adapts the Agent interaction callbacks to HTTP.

API-token setup uses one ordinary request. Server supplies the submitted value
to the expected Agent prompt and awaits the original
`addProviderCredential()` result. It does not create an authentication job or
event stream.

OAuth uses four logical operations:

1. `start` starts exactly one `agent.addProviderCredential()` Promise and
   returns the first externally actionable prompt or authorization step;
2. `respond` answers the currently pending Agent prompt;
3. `result` waits for that same original Promise and returns completion, or a
   later prompt if user input becomes necessary;
4. `cancel` aborts and removes the flow.

Each flow is transient and contains only its `AbortController`, original
Promise, current prompt resolver, and current outward step. A random `flowId`
prevents an old page from addressing a replacement flow. A monotonic `revision`
prevents a duplicated response from answering a later prompt. There is no auth
SSE, event replay, terminal-result retention timer, or durable flow recovery.

The browser calls `result` after displaying the authorization instructions.
That request does not start Provider polling. Any device-code polling or
callback wait is already running inside the original Agent/`@loopiq/ai`
operation.

Exact HTTP paths and response schemas should be finalized with implementation
tests. The logical lifecycle above is the accepted part.

## Product UI Boundary

Status: Partially accepted direction

The following ownership decision is accepted:

- product UI source code, components, state, protocol client, and build
  configuration do not belong in `packages/server`.

The following decisions are not accepted yet:

- whether the product UI is a new `packages/ui` workspace;
- whether Server serves its compiled/static assets;
- whether it runs on the same origin, behind a development proxy, or inside a
  desktop shell;
- its route prefix;
- whether DevUI and product UI share any protocol-client code;
- its build system.

Static delivery, if selected, does not transfer source or state ownership to
Server.

## Server Ownership Rules

These boundaries follow the current Agent architecture and remain valid for
future Server work:

| Concern | Owner |
| --- | --- |
| Agent configuration and defaults | Agent |
| Provider registry, model catalog, and credential persistence | Agent |
| Provider-specific authentication mechanics | `@loopiq/ai`, consumed through Agent |
| Session identity, messages, configuration, and persistence | Agent |
| Run execution, steering, abort, and event identity | Agent |
| HTTP request validation, status codes, and serialization | Server |
| Browser Origin/CORS policy | Server |
| SSE encoding and transport backpressure | Server |
| Transient HTTP authentication-flow bridging | Server |
| Session selection and presentation state | UI client |
| Product UI implementation | Future UI owner, never Server |

Server must not parse Session JSONL, read Agent credential/settings files,
construct Providers directly, or reproduce Agent state in a second durable
store.

## Process Lifecycle

The current process starts at module evaluation and has no reviewed shutdown
coordination.

**Proposed direction, not yet accepted:** construction should remain free of
Provider login or model requests; shutdown should stop accepting requests,
close Server-owned streams and auth flows, call
`agent.shutdown({ abortRunning: true })`, and release Session writer leases once.

The exact signal, timeout, and exit-code policy requires real-process tests
before it becomes a contract.

## Decisions Required Before Implementation

1. Session bootstrap: remove Server-selected Session state, but first define the
   minimal UI discovery/selection operation.
2. UI delivery and Origin policy: choose same-origin delivery or an exact
   separately configured UI origin.
3. Recovery: resolve roadmap item 10 at the Agent boundary before specifying
   Server transcript/replay/Run endpoints.
4. Source organization: choose the smallest capability extraction required by
   the first accepted Server change; do not approve a speculative full tree.
5. Process lifecycle: define signal handling, pending Run/Auth Flow behavior,
   timeout, and exit semantics.
6. Verification: add current-route process tests first, then add browser and
   recovery tests only as those capabilities become real.

## Explicitly Rejected as Current Truth

The following were present in the previous draft but are not accepted current
behavior or target defaults:

- a 512-event Session replay buffer;
- retention of 100 Run snapshots;
- `/api/bootstrap` and a fixed bootstrap payload;
- transcript-first recovery and a fixed transcript cursor protocol;
- a canonical `GET /messages` or `GET /runs/:runId` route;
- serving product UI at `/` and DevUI at `/devui/`;
- `LOOPIQ_HOST`, `LOOPIQ_UI_DIR`, and `LOOPIQ_DEVUI_DIR` configuration;
- a fixed Server source-module tree;
- duplicate recovery implementations across two existing UIs;
- browser tests for endpoints and UI behavior that do not exist.

If any of these is proposed again, it must be justified from a current user
requirement, assigned to the correct owner, and reviewed independently.
