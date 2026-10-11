# App Protocol

Private, browser-compatible wire contracts for the app-server refactor. This
package currently implements RPC envelope parsing only. Server and DevUI still
use their existing REST/SSE path; no WebSocket handler consumes this package yet.

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
- Method-specific parameters, results, error data, endpoint admission and byte
  limits belong to the next contract slices. An envelope match alone authorizes
  no command and establishes no domain-payload safety guarantee. Call the parser
  only after the receiving transport has enforced its encoded message bound.

Exported TypeBox schemas and their derived TypeScript types describe the same
four envelope variants. The package imports no Agent/provider or platform APIs.
Bundling/delivering shared contracts to DevUI is a later integration step.

## Development

From the repository root:

```sh
npm run build -w @loopiq/app-protocol
npm run typecheck -w @loopiq/app-protocol
npm run test -w @loopiq/app-protocol
```

The test command fails when no tests are discovered. Scope and subsequent work
are tracked in [delivery PR 01](../../docs/proposals/app-server-implementation/delivery-plan.md).
