# Vendored Test Suite Baseline

Date: 2026-07-04
Branch: `feat/vendor-pi-skeleton`
Runner: vitest v4.1.9

## Scope

Only the `ai` package (`@loopiq/ai`) test suite is vendored, copied from
upstream `pi/packages/ai/test` (90 `*.test.ts` files) and renamed
(`@earendil-works/pi-ai` -> `@loopiq/ai`, 0 references remaining). The
`agent` package tests are intentionally NOT vendored. Offline verification
for the skeleton remains `npm run smoke` (the `examples/smoke.ts` check).

## Results (`@loopiq/ai`)

| Metric     | Passed | Failed | Skipped | Total |
|------------|--------|--------|---------|-------|
| Test files | 65     | 0      | 25      | 90    |
| Tests      | 446    | 0      | 731     | 1177  |

Vitest summary line:

```
Test Files  65 passed | 25 skipped (90)
     Tests  446 passed | 731 skipped (1177)
  Duration  5.54s
```

The run completed naturally in ~5.5s. It was NOT time-bounded or truncated
(no `timeout`/`gtimeout` on this host; the suite finished well under the
~7 minute cap, so no manual kill was needed).

## Failure categorization

There were **zero failures**. Tests expected to fail on a network-less,
canvas-less host instead SKIP themselves via guards (`describe.skipIf(...)`,
missing-API-key / missing-native-dep checks), which is why 731 tests are
skipped rather than failed.

- Network (fetch / 401 / timeout / provider calls): **0 failures** — the
  provider-calling suites are guarded and skip when no API keys are present
  (the bulk of the 25 skipped files / 731 skipped tests).
- Canvas / image native module: **0 failures** — no test file references
  `canvas`; image-dependent cases skip rather than fail.
- Other (compile / `@loopiq/*` resolution / offline assertion failures):
  **0 failures.** No non-network, non-canvas failures to report.

## Notes / concerns

- The 446 passing tests are offline logic tests (parsing, schema, utils,
  model catalogs, etc.) — e.g. `bedrock-models.test.ts` passes and reports
  105 Bedrock models — confirming imports and `@loopiq/ai` alias resolution
  work correctly.
- No API keys and no `canvas` devDependency are present by design; the
  network/image suites self-skip, so this is a clean baseline with no real
  (non-environmental) failures.
