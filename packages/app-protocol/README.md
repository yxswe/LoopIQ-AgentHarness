# App Protocol

Private, browser-compatible wire contracts for the app-server refactor. This
package implements RPC envelopes, initialization/status schemas and method
direction rules. Server and DevUI still use their existing REST/SSE path; no
WebSocket handler consumes this package yet.

## RPC envelope

`parseRpcMessage(text)` returns a discriminated `kind`: `request`,
`notification`, `success`, `failure`, or `invalid`. Valid variants contain the
original parsed `message`. Invalid JSON returns code `-32700`; valid JSON with
an invalid envelope returns `-32600`. The parser does not send an error reply;
the receiving endpoint decides how to handle malformed input or responses.

- One JSON-RPC 2.0 object per message; batches are rejected.
- Request and success IDs are nonempty strings. Error response IDs may also be
  `null` when the peer cannot correlate an invalid request. Notifications omit ID.
- Methods are nonempty strings and parameters are required named objects.
- Responses contain exactly one of `result` or `error`; response objects cannot
  also contain method fields. Envelope/error-object extra fields are rejected.
- An envelope match alone authorizes no command and establishes no payload safety
  guarantee. Call the parser only after the receiving transport has enforced its
  encoded message bound, then apply direction and payload validation separately.
  Domain payloads, error data, admission and byte limits remain planned.

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
handler. Domain schemas and complete typed method maps follow in PRs 03–04;
delivery classifications, error reasons and UTF-8 bounds follow in PR 02b.

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
