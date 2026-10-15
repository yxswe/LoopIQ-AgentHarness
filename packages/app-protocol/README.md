# App Protocol

Private, browser-compatible wire contracts for the app-server refactor. This
package implements RPC envelopes, initialization/status schemas, direction rules,
v1 errors, delivery classifications, UTF-8 size checks, Run and catalog contracts. Server and DevUI still
use their existing REST/SSE path; no WebSocket handler consumes this package yet.

## RPC envelope

`parseRpcMessage(text)` returns a discriminated `kind`: `request`,
`notification`, `success`, `failure`, `invalid`, or `tooLarge`. Valid variants
contain the original parsed `message`. Invalid JSON returns code `-32700`; valid JSON with
an invalid envelope returns `-32600`. The parser does not send an error reply;
the receiving endpoint decides how to handle malformed input or responses.
Text exceeding the 32 MiB UTF-8 bound returns `{ kind: "tooLarge" }` before
`JSON.parse`, even if the text is malformed. It carries no correlated request ID
or fabricated business error. Transports must also bound incoming messages before
materializing text; this parser guard does not bound socket buffering.

- One JSON-RPC 2.0 object per message; batches are rejected.
- Request and success IDs are nonempty strings. Error response IDs may also be
  `null` when the peer cannot correlate an invalid request. Notifications omit ID.
- Methods are nonempty strings and parameters are required named objects.
- Responses contain exactly one of `result` or `error`; response objects cannot
  also contain method fields. Envelope/error-object extra fields are rejected.
- An envelope match alone authorizes no command and establishes no payload safety
  guarantee. Call the parser only after the receiving transport has enforced its
  encoded message bound, then apply direction and payload validation separately.
  On failure envelopes, validate `message.error` with `RpcErrorSchema` before
  using it as a v1 error. The generic envelope still permits unknown error data;
  Run payload schemas require a separate check; admission remains planned.

Exported TypeBox schemas and their derived TypeScript types describe the same
four envelope variants. The package imports no Agent/provider or platform APIs.
Bundling/delivering shared contracts to DevUI is a later integration step.

## Initialization and availability

`PROTOCOL_VERSION` is the integer `1`, encoded as `protocolVersion`; strings and
other versions fail the v1 schemas. `RPC_ENDPOINTS` fixes the two endpoint paths.
Each peer's first request is `connection/initialize`, with these named parameters:

| Endpoint | Parameter schema | Required fields |
| --- | --- | --- |
| `/ws/client` | `FrontendInitializeParamsSchema` | `protocolVersion`, nonempty `token` |
| `/ws/runtime` | `RuntimeInitializeParamsSchema` | The same fields plus `runtimeServiceId` and `runtimeBootId` |

Runtime IDs are bare, 36-character UUIDs. The service ID survives process
restarts; the boot ID changes on restart and remains stable across reconnects.
Initialization schemas reject extra fields, including a frontend `role` or
Runtime identity. Endpoint selection comes from the accepting route, never a
caller-supplied role. Checking a token's shape does not authenticate it: the
server must compare the endpoint-specific credential and configured service ID.
Tokens belong only in initialization parameters and must be redacted in logs.

Both endpoints return `InitializeResultSchema`, exactly `{ "protocolVersion": 1 }`,
inside a success envelope correlated by the request ID. This acknowledges the
connection identity/version. On the backend it leaves inventory synchronization
pending; it contains no `ready` flag and has no second `initialized` notification.

`RuntimeStatusSchema` defines the parameters of `runtime/status`:

```json
{
  "runtimeServiceId": "019a0665-dc18-7000-8000-000000000001",
  "state": "ready"
}
```

The state is `offline`, `syncing`, or `ready`. App-server notifies frontends of
availability and the initialized Runtime of readiness. Only successful inventory
reconciliation and catalog persistence allow `ready`; authentication alone does
not. Status schemas describe data, while later connection owners enforce timing,
generation fencing and execution admission. No connection state machine exists yet.

## Method directions

`RPC_METHODS` declares the v1 request and notification allowlists for
`frontendToServer`, `runtimeToServer`, `serverToRuntime`, and `serverToFrontend`.
`isMethodAllowed(direction, kind, method)` checks that declaration. In particular:

- Frontends cannot request backend inventory or snapshots, or publish updates.
- Runtime can request initialization and notify Session updates. App-server owns
  frontend catalog/observation operations; backend rename is absent.
- `runtime/status` goes from app-server to both peers; `session/update` goes from
  Runtime to app-server and from app-server to frontends. Observation expiry and
  catalog changes go only to frontends.
- Requests cannot be sent as notifications. Undeclared methods, business `ping`
  and `connection/initialized` are rejected by the allowlist.

Responses follow pending request IDs and are not methods in this registry.
Direction permission does not validate params/results or imply an installed
handler. Run and catalog schemas are available below; lifecycle/inventory schemas
and complete directional method maps follow in PRs 03c–04.

## Session catalog and availability

`CATALOG_METHOD_SCHEMAS` defines app-server-owned frontend operations. None is
forwarded to Runtime as a Session command or opens execution resources.

| Method | Parameters | Success result |
| --- | --- | --- |
| `runtime/read` | Exactly `{}` | Existing `RuntimeStatus`: configured service UUID and `offline`, `syncing` or `ready` link state. |
| `session/list` | Exactly `{}` | `{ catalogRevision, sessions: SessionCatalogEntry[], runtime: RuntimeStatus }`, including an empty list. No pagination in v1. |
| `session/read` | `sessionId` UUID | `SessionCatalogView`: `{ catalogRevision, session: SessionCatalogEntry, runtime: RuntimeStatus }`. |
| `session/rename` | `sessionId` UUID, nonblank `name` | The same view after the trimmed name and revisions have been durably committed; available offline. |

`SessionCatalogEntrySchema` contains only the target design's public fields:
Session/service UUIDs, a nonempty trimmed name, optional Runtime-reported
`workspaceDir`, creation/catalog-update timestamps, optional `lastActivityAt`,
`metadataRevision`, and `lifecycle` (`creating`, `ready`, `deleting`, `missing`).
All timestamps use RFC 3339 date-time and both revision counters are nonnegative
safe integers. Creating/missing records may lack a resolved workspace. Paths
remain opaque nonempty strings here; Runtime validates absolute paths and their
existence on its own machine. Catalog update time does not imply execution activity.

Lifecycle describes persisted catalog state; `runtime` reports current link
availability for the configured single service. A `ready` catalog row can have
an offline Runtime. Link readiness alone does not prove a Session is idle,
unlocked or executable. These replies contain no cached Run state or transcript.
The server must match service bindings and Session identities independently of
shape validation and admit new work only for an eligible `ready` Session.

`CatalogChangedSchema` defines `catalog/changed` notification params as exactly
`{ catalogRevision }`. Send it only to authenticated frontends after a catalog
commit, prompting a refresh without subscribing to Sessions. List/read/rename
return the revision of the catalog view they read; per-entry `metadataRevision`
tracks that entry's changes. Rename accepts surrounding whitespace, which its
handler trims; schemas do not mutate inputs. Stored names reject edge whitespace,
including terminal newlines. Extra fields are rejected throughout, including
private creation/deletion evidence, credentials and history. Durability, revision
ordering, binding checks and notifications still require real handlers.

## Run commands and retained results

`RUN_METHOD_SCHEMAS[method]` exposes `params` and `result` TypeBox schemas for
both command hops. `RunMethodMap` derives each method's TypeScript types from
those schemas. Validate the envelope and direction first, then the appropriate
payload; `parseRpcMessage` alone does not perform this validation.

| Method | Parameters | Success result |
| --- | --- | --- |
| `run/start` | `sessionId`, `submissionId`, nonempty `text` | `RunIdentity`: durable acceptance or recognition of the original submission, without waiting for completion. |
| `run/read` | `sessionId` and exactly one of `runId` / `submissionId` | `RunLookup`: `known` with a `RunView`, `notAccepted`, or `unknown` with `recordsUnavailable` / `legacyHistory`. |
| `run/steer` | Exact `sessionId` / `runId`, nonempty `text`, optional boolean `interruptCurrentInference` | Exactly `{}`: queued in the target Run, with no consumption or durable replay promise. |
| `run/abort` | Exact `sessionId` / `runId` | `SettledRunView`: actual retained outcome after reservation release; normal completion may win the race. |
| `run/result` | Exact `sessionId` / `runId` | `RunResultView`: settled Run, final assistant items, all output item IDs and result details. |

Session, Run and submission IDs are bare 36-character UUIDs. Input is preserved
without trimming or normalization; handlers must enforce the 64 KiB UTF-8 limit.
`RunView` separates `accepted`, `running`, `settling` and `settled`. Only settled
views carry `completedAt` (RFC 3339 date-time) and an outcome: `completed`,
`aborted`, `interrupted`, or `failed` with a public `{ code, message }` error.
Busy and unsettled-result rejection use RPC business errors; delivery uncertainty
is neither a Run state nor a terminal outcome.

`HistoryItemSchema` in `history.ts` owns the display shape reused by results
and future observation contracts. Content is text; legacy `runId: null` and
nonempty historical item IDs are preserved. Tool-call IDs remain separate opaque
strings. Item timestamps are RFC 3339 date-times; revisions and optional token
counts are nonnegative safe integers. `RunResultView.finalItems` admits only
assistant items with a Run ID; an interrupted Run may have no output items.
Usage retains `complete`, `partial` or `unavailable` coverage without defaulting
missing counts. Objects reject extra fields, including internal provider data.

These are shape checks. Runtime owners must establish durable acceptance and
settlement, reserve `notAccepted` for authoritative submission lookups, match
response identities, resolve item references and report truthful usage. Mappers
must construct safe text; schemas cannot redact embedded secrets or prove these
relationships. Execution, storage, dispatch and sockets remain unimplemented.

## Errors and delivery knowledge

`RPC_ERROR_CODES` and `RpcErrorSchema` fix the supported v1 error payloads:

| Code | Meaning | Payload |
| --- | --- | --- |
| `-32700` | Parse error | `code`, `message` |
| `-32600` | Invalid request | `code`, `message` |
| `-32601` | Method not found / disallowed direction | `code`, `message` |
| `-32602` | Invalid params | `code`, `message` |
| `-32000` | Business error | `code`, `message`, `data: { reason }` |

`BusinessErrorReasonSchema` contains all 23 reasons from
[design section 5.2](../../docs/proposals/app-server-runtime-design.md#52-errors).
The strict schema rejects extra fields at both error and data levels; internal
exceptions, stacks and provider headers are not public error objects. Callers
must still construct safe message text; schemas cannot redact secrets in strings.
RPC error correlation remains the original attempt ID, or `null` when unknown.

`DeliveryClassificationSchema` describes the caller's knowledge of one attempt.
It is separate metadata, not an extra RPC envelope/error field or a Run outcome:

| Classification | Meaning |
| --- | --- |
| `rejected` | Evidence establishes that this attempt was refused; it says nothing about an earlier attempt with the same submission ID. |
| `uncertain` | Forwarding/admission may have happened, but authoritative confirmation is unavailable. |
| `confirmed` | A validated success response establishes the method's success meaning; start acceptance does not mean the Run has settled. |

Timeout or disconnect after possible forwarding stays `uncertain`. Neither is a
business reason, failed Run, implicit abort or permission to resend. A definitely
unsent attempt can be rejected. Receiving an error alone does not prove absence
of side effects; admission and operation evidence determine classification.
Connection owners will implement that decision; the schema does not infer it.

## Byte bounds

`PROTOCOL_LIMITS` centralizes inclusive defaults. `isWithinUtf8Limit(text, maxBytes)`
returns a boolean using standard `TextEncoder` UTF-8 encoding. It neither truncates
nor changes the text. Unpaired UTF-16 surrogates encode as replacement characters.

| Field | Default | Measured content / behavior |
| --- | --- | --- |
| `inputBytes` | 64 KiB | Raw input text; reject before admission with `INPUT_TOO_LARGE`. |
| `jsonMessageBytes` | 32 MiB | Entire encoded JSON message, including the envelope; the parser returns `tooLarge`. |
| `snapshotBytes`, `resultBytes` | 16 MiB each | Entire encoded snapshot/result RPC response; use `SNAPSHOT_TOO_LARGE` without truncating saved history. |
| `rpcTimeoutMs` | 30 seconds | Ordinary wait deadline; stopping the wait does not cancel execution. |

For snapshots/results, pass the complete `JSON.stringify(...)` response to the
size check so escaping and envelope overhead count. Input and response owners
must call the shared check when their handlers land; only the generic parser's
32 MiB guard is wired today. Queue limits, timers and network rejection belong
to the later transport/observation implementations.

## Development

From the repository root:

```sh
npm run build -w @loopiq/app-protocol
npm run typecheck -w @loopiq/app-protocol
npm run test -w @loopiq/app-protocol
```

The test command fails when no tests are discovered. Scope and subsequent work
are tracked in the [delivery plan](../../docs/proposals/app-server-implementation/delivery-plan.md).
To review the initialization/direction slice alone, run
`npm run test -w @loopiq/app-protocol -- src/connection.test.ts` and inspect its
valid handshake, wrong-endpoint, unsupported-version and direction fixtures.
The 02b fixtures are in `rpc.test.ts` (strict errors), `connection.test.ts`
(delivery knowledge), and `limits.test.ts` (byte boundaries and the parser guard).
For 03a, run `npm run test -w @loopiq/app-protocol -- src/run.test.ts` and inspect
method round trips, ambiguous lookups, terminal outcomes and retained items.
For 03b, run `npm run test -w @loopiq/app-protocol -- src/catalog.test.ts` and
inspect offline metadata, name normalization boundaries and private-field rejection.
