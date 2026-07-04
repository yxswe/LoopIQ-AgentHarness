# Vendored Test Suite Baseline

Date: 2026-07-04
Branch: `feat/vendor-pi-skeleton`
Runner: vitest v4.1.9 (invoked with a 300s wall-clock cap per package)

## Results

| Package        | Test files | Passed | Failed | Exit |
|----------------|-----------|--------|--------|------|
| `@loopiq/ai`    | 0 found   | 0      | 0      | 1    |
| `@loopiq/agent` | 0 found   | 0      | 0      | 1    |

Both packages exit with: `No test files found, exiting with code 1`.
Default include glob `**/*.{test,spec}.?(c|m)[jt]s?(x)` matches nothing —
there are zero `*.test.ts` / `*.spec.ts` files anywhere in the repo
(outside `node_modules`).

## Failure categorization

- Network (fetch/401/timeout): none observed — no tests ran.
- Canvas / image native module: none observed — no tests ran.
- Other: **the upstream test suites were not vendored.** Only `src/`
  production code was copied. The offline faux-based agent tests the task
  expected (`e2e.test.ts`, `agent-loop.test.ts`, harness tests) do not
  exist in the vendored packages.

## Notes / concerns

- Test tooling itself works: vitest installs, resolves the `@loopiq/ai`
  aliases, and starts cleanly in both packages.
- `packages/agent/package.json` has a `test:harness` script pointing at
  `vitest.harness.config.ts`, but that config file was not vendored either.
- The offline smoke example (`examples/smoke.ts`, run via `npm run smoke`)
  passes and is currently the only executable offline verification of the
  skeleton.
- Recommendation: vendor the upstream test files (and
  `vitest.harness.config.ts`) if a running baseline is desired; otherwise
  treat the smoke example as the offline core check.
