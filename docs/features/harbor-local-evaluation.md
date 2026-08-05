# Harbor Local Evaluation Integration

**Status:** Proposed

**Reviewed:** 2026-08-05

**Initial transport:** LoopIQ CLI in a Harbor trial container

**Harbor reference:** [`harbor-framework/harbor` at `cc4b7be`](https://github.com/harbor-framework/harbor/commit/cc4b7be7c1ace2621b38c4e2e13ef736a9bc884f)

## Decision

Use Harbor's installed-agent adapter pattern to invoke one LoopIQ CLI process
per trial. Do not add a new LoopIQ Server layer for the first integration.

The command boundary is the smallest surface that already exercises the real
Agent composition root, Session persistence, Provider selection, tools, event
stream, and shutdown path. Harbor provides trial scheduling, environment
isolation, optional agent-phase timeout enforcement, verifier execution, and
configurable environment deletion. The LoopIQ evaluation profile must set those
limits explicitly and verify cleanup rather than assume their defaults. Adding
a second long-lived service would duplicate lifecycle ownership before LoopIQ
has a stable replayable evaluation transport.

The current `@loopiq/server` remains the DevUI backend. Its Run endpoint returns
Session and Run identities, while live SSE delivery has no durable replay
contract. It is useful for browser interaction, but it is not the source of
truth for unattended evaluation artifacts.

## Trial Lifecycle and Ownership

```text
Harbor evaluation
  -> create and start the Agent environment
  -> adapter setup/install
  -> adapter supervisor invokes one LoopIQ CLI process group
  -> CLI creates Agent + fresh Session + one Run
  -> normal settlement: CLI emits run_settled and attempts Agent shutdown
     timeout/failure: partial logs; supervisor terminates the process group
  -> adapter writes one trial terminal manifest
  -> verifier branch
       separate verifier: Harbor stops Agent environment, then runs verifier
       shared verifier: prove Agent processes stopped, run verifier, then Harbor stops environment
  -> Harbor records the configured deletion/cleanup outcome
  -> backfill AgentContext from synchronized logs when it is still empty
```

This is a lifecycle requirement, not an unconditional Harbor guarantee. The
agent-phase timeout is optional unless the task/job config supplies a finite
`timeout_sec` or override. Environment deletion is configurable and cleanup can
fail. The initial profile must set `environment.delete: true`, retain cleanup
errors, and verify that no process remains.

Prefer a separate verifier environment when the benchmark supports it, because
the Agent environment is stopped before scoring. With a shared verifier, the
adapter supervisor must prove that LoopIQ and every child process have exited
before the verifier runs; otherwise a background command can continue changing
the workspace during scoring.

| Owner | Responsibilities | Must not own |
| --- | --- | --- |
| Harbor | Trial scheduling, environment lifecycle, configured agent-phase timeout, verifier, result collection, cleanup attempt | LoopIQ Session semantics or internal event interpretation |
| LoopIQ Harbor adapter | Install a pinned LoopIQ artifact, isolate Agent Home, supervise the CLI process group, capture output, normalize outcome, write trace artifacts | Provider/tool loop, Session persistence, scoring, or a second Agent runtime |
| LoopIQ CLI | Construct one Agent, create/open one Session, start one Run, render events, map terminal status, shut down owned resources | Container lifetime, benchmark verification, or cross-trial state |
| LoopIQ Agent | Provider/tool turns, context compaction, message persistence, Run identity, abort, event production | Harbor schemas, artifact layout, or trial scheduling |
| Verifier | Inspect workspace/output and calculate task reward | Agent lifecycle or trace repair |

The "LoopIQ Agent adapter" is therefore Harbor-side glue, not another Agent and
not a LoopIQ Server. It translates Harbor's installed-agent lifecycle into one
CLI invocation and translates LoopIQ artifacts back into Harbor's result
context.

## Initial Invocation Contract

The logical LoopIQ command inside the adapter supervisor is:

```bash
loopiq run --workspace . \
  --model "$LOOPIQ_MODEL" \
  --format jsonl \
  --stdin < "$instruction_path" \
  > /logs/agent/loopiq-events.jsonl \
  2> /logs/agent/loopiq-stderr.log
```

Harbor's environment `exec()` API does not expose a stdin stream or a child
process/signal handle. The adapter must first upload the instruction as a mode
`0600` temporary file, then invoke an adapter-owned supervisor that redirects
that file to CLI stdin, redirects stdout/stderr directly to the Agent log mount,
and records the CLI PID/process group. Do not interpolate the instruction into a
logged shell command, and do not retain another full JSONL copy in an
`ExecResult`.

The supervisor runs with the trial workspace as its working directory. The
adapter must not infer success from process exit code alone; it also inspects
the correlated native `run_settled` event when present and preserves any
mismatch in its trial terminal manifest.

Do not pass `--new`: it is currently read only for its mutual-exclusion check
with `--session` and never changes selection behavior. Omitting `--session`
already creates a fresh Session. Reintroduce `--new` in adapter examples only if
Phase 0 CLI work gives it a tested contract.

Do not pass Provider request policy flags to `loopiq run`; the current Run path
silently ignores them. A clean trial home may be configured first with
`loopiq config set-provider-request`, subject to Provider support, while
the explicitly configured Harbor agent-phase timeout remains the outer safety
limit.

### Credentials and Trial Isolation

- Use API-token authentication supplied through Harbor/container secrets for
  the first milestone.
- Normal `loopiq run` does not perform interactive login. It resolves
  authentication when the Provider request starts; missing credentials become
  a failed accepted Run. Supply ambient Provider environment credentials or
  pre-provision the isolated Agent Home.
- Do not invoke interactive `providers add` during a trial. Its TTY/OAuth flow
  has no whole-command signal controller today.
- Do not copy a developer's `~/.loopiq` into a trial.
- Give every trial a clean, private home directory so `createAgent()` resolves
  a separate `~/.loopiq` and cannot reuse credentials, configuration, Sessions,
  or stale locks from another trial.
- Redact secret environment variables from command logging and artifact
  manifests.
- Treat the current OAuth-only `openai-codex` path as unsupported for
  non-interactive Phase 1 evaluation. Add it later only with an explicit secure
  credential bootstrap contract.

### Installation Contract

The adapter setup stage must install an immutable LoopIQ build. The current CLI
does not implement `loopiq --version`; adding trustworthy version output is a
Phase 0 prerequisite, not a command the first draft adapter can assume. Until
then, validate a pinned image/build manifest and record its image digest, source
revision, package-lock digest, and Node version. Once available, connect version
discovery through Harbor's installed-agent version-command hook.

The current packages are private, and `@loopiq/agent` has no package version.
That is a reproducibility blocker for a normal package-install adapter, not a
reason to add a Server.

## Proposed Adapter Contract

The first adapter should extend Harbor's installed-agent base and use these
semantics:

### Setup

1. Validate the expected OS, Node runtime, CLI executable, and LoopIQ build
   identity.
2. Create the clean trial home and artifact directories.
3. Configure only the selected Provider/model and non-interactive API-token
   credential inputs.
4. Fail before task execution if the model or credential contract cannot be
   validated without prompting.

### Run

1. Leave Harbor's `AgentContext` empty while execution is active.
2. Upload the instruction as a private temporary file and redirect it to CLI
   stdin; never interpolate it into the logged command.
3. Redirect CLI stdout and stderr directly to separate Agent log files so
   Harbor's `ExecResult` does not retain another unbounded copy.
4. Run through a supervisor with an inner deadline below the explicitly
   configured Harbor agent-phase timeout. Save the PID/process group. On the
   inner deadline, send `SIGINT`, wait a finite grace period, then send
   `SIGTERM` and `SIGKILL` to the entire group as needed. Only the first
   `SIGINT` is currently a graceful LoopIQ abort path.
5. On normal settlement, validate JSONL syntax, identity consistency, monotonic
   sequence values, and exactly one native `run_settled` event. On startup
   failure or forced termination, allow the native terminal to be missing and
   record why.
6. In all paths, write exactly one adapter-owned trial terminal manifest with
   process exit status/signal, wall time, timeout decisions, cleanup state, and
   native-terminal state.

### Post-Run Context

Harbor calls `populate_context_post_run()` only when `AgentContext` is still
empty. The adapter's `run()` implementation must therefore not pre-populate
metadata there.

`populate_context_post_run()` should add a small summary and pointers to durable
artifacts. It must not place the complete event stream or full model transcript
inside `AgentContext`.

For the first milestone:

```text
SUPPORTS_ATIF = False
```

ATIF support should be enabled only after a tested conversion exists and the
LoopIQ source event schema is versioned.

## Agent Log Layout

Use stable adapter-owned paths in Harbor's Agent log mount. `/logs/agent` is not
the separate `/logs/artifacts` artifact-collector namespace:

```text
/logs/agent/
  loopiq-events.jsonl
  loopiq-stderr.log
  loopiq-run-manifest.json
  trajectory.json              # Phase 2 ATIF conversion
```

`loopiq-run-manifest.json` should contain at least:

- adapter name and version;
- pinned Harbor version or source revision;
- LoopIQ version and source revision;
- CLI event schema version when available;
- model and Provider identifiers without credentials;
- Harbor trial/task identifiers;
- Session, runtime, and Run identifiers;
- start/end timestamps and wall-clock duration;
- process exit code or terminating signal;
- native terminal state (`present`, `missing`, or `invalid`) and reason;
- terminal Run status and optional stop reason, including its source;
- timeout/forced-kill flags;
- paths, byte sizes, checksums, and truncation state for each artifact;
- aggregate usage/cost with explicit `known`, `partial`, or `unknown` state.

Raw JSONL is one evidence source, not the sole authority. The normalized outcome
must combine JSONL, stderr, the supervisor process record, and Harbor's trial
result. Startup failure may produce only stderr, forced termination may leave a
truncated JSONL file, and Harbor alone records outer timeout and environment
cleanup outcomes. The manifest indexes those sources; it does not replace them.

## Trace Readiness

### Data Available Today

The current event envelope exposes:

- Session, runtime, and optional Run identity;
- a per-runtime sequence and timestamp;
- Agent, turn, message, tool, compaction, and settlement lifecycle events;
- complete committed messages at `message_end`;
- incremental, non-accumulated assistant progress deltas without a byte-size
  guarantee;
- Provider response status and selected redacted headers;
- Provider-reported usage and cost on individual assistant messages when the
  Provider supplies them.

This is enough to debug an initial trial and construct a partial trajectory.

### Missing or Ambiguous Data

| Gap | Evaluation impact | Planned owner |
| --- | --- | --- |
| No CLI schema name/version | Adapter changes can silently break after internal event evolution | CLI external event contract |
| Incomplete `run_settled` terminal record | Exit code, final stop reason, returned messages, and usage require joining other records | Agent Run result plus CLI renderer |
| No aggregate Run usage/cost | Benchmark accounting can omit turns or double count fields | Agent Run, surfaced by CLI |
| Compaction inference omitted from Run accounting | Long tasks under-report tokens, latency, and cost | Context manager plus Agent Run accounting |
| Incomplete retry/request timing events | Latency and reliability cannot be attributed accurately | Provider/Agent observability contract |
| No stable tool-duration/resource metrics | Tool bottlenecks are difficult to compare | Agent event contract |
| Partial content redaction policy | Raw traces can expose source, paths, prompts, outputs, or secrets | Adapter artifact policy plus CLI safe serialization |
| No artifact/build identity | Results are not reproducible across revisions | Packaging plus adapter manifest |
| No durable event replay | A Server subscriber can miss events after disconnect | Session event-delivery roadmap; not needed for CLI Phase 1 |

The adapter must label current accounting as partial. It must not estimate
missing compaction usage from unrelated message totals and present that value as
Provider-reported truth.

## ATIF Conversion Plan

Use the adapter as the conversion owner. The Agent should emit a stable,
LoopIQ-native event contract; it should not import Harbor or ATIF types into the
core runtime.

Phase 2 conversion should target `ATIF-v1.7` as validated against the pinned
Harbor reference above, and include fixture tests for:

- direct answer;
- multiple sequential tool turns;
- parallel tool calls with source-ordered results;
- Provider failure and length termination;
- foreground tool error and timeout;
- context compaction;
- steering and abort;
- missing/partial usage;
- artifact truncation and redaction.

Only set `SUPPORTS_ATIF = True` after the synchronized host trial contains
`agent/trajectory.json`, Harbor's `Trajectory` model validates it, and the
fixture suite proves deterministic identity, ordering, and terminal mapping.
For built-in trace export, register the LoopIQ adapter with Harbor's
`AgentFactory`/`AgentName` path or first add equivalent import-path support;
setting the boolean alone is insufficient.

## Why the Server Is Deferred

A Server transport becomes justified when a real caller requires one or more
of the following:

- a persistent warm Agent across multiple trials;
- remote execution outside the Harbor container;
- concurrent Run scheduling and admission control;
- durable reconnect/replay with cursors;
- a managed cancellation/status API independent of a child process;
- centralized credential brokering or multi-tenant policy.

If those requirements appear, extend the existing Server around the same Agent
API and first complete the event-delivery roadmap. Do not create an evaluation-
specific second runtime or make HTTP adapters own Provider/tool logic.

## Phased TODO Plan

### Phase 0 — One Reproducible Smoke Trial

- Pin a LoopIQ source revision or build artifact and container image digest.
- Add trustworthy `loopiq --version` output and record build identity.
- Implement the minimal installed-agent adapter with `SUPPORTS_ATIF = False`.
- Configure a finite Harbor agent-phase timeout and
  `environment.delete: true`; do not rely on defaults.
- Implement the adapter process-group supervisor with a shorter inner deadline,
  private instruction file, direct log redirection, and one trial terminal
  manifest in every outcome.
- Select and record separate or shared verifier mode. Prefer separate; for
  shared mode, prove all Agent processes have stopped before scoring.
- Isolate HOME, configure one API-token Provider/model, and run one fresh CLI
  Session per trial.
- Capture raw JSONL, stderr, supervisor process state, Harbor result, and the
  adapter manifest.
- Map Harbor timeout, process signal, exit code, optional native
  `run_settled`, and cleanup result into one normalized outcome.
- Run a small benchmark smoke set that does not require background Bash. Do not
  claim background execution is disabled until an enforceable tool policy
  exists; process-group and environment cleanup remain the final boundaries.

### Phase 1 — Reliable CLI Evaluation Boundary

- Complete Phase 0 and Phase 1 work in
  [`cli-headless-readiness.md`](cli-headless-readiness.md).
- Add an Agent-owned Run deadline and budgets while retaining the explicitly
  configured Harbor agent-phase timeout.
- Stabilize and version the CLI terminal/event contract.
- Add aggregate Run usage/cost including compaction.
- Make signal handling, stdout backpressure, and child-process cleanup
  deterministic.
- Add end-to-end Harbor fixtures for success, failure, timeout, abort, large
  output, and container teardown.

### Phase 2 — Standardized Trajectories

- Implement `ATIF-v1.7` conversion against the pinned Harbor version.
- Add trace validation, checksums, artifact limits, and redaction profiles.
- Produce and validate host `agent/trajectory.json`, register the adapter for
  built-in trace export, then enable `SUPPORTS_ATIF` and trajectory tooling.
- Add benchmark suites only after their environment, verifier, model, and
  LoopIQ build are all pinned.

### Phase 3 — Server Transport Only If Required

- Write the concrete remote/persistent execution use case.
- Add bounded event replay, cursor/gap semantics, non-blocking subscribers, and
  terminal delivery guarantees.
- Define Server-side admission, cancellation, authentication, and worker
  lifecycle.
- Reuse the same versioned event and artifact semantics as the CLI adapter.

## Phase 1 Acceptance Criteria

The CLI-based Harbor path is ready for repeatable local evaluation when:

- every trial starts from a clean Agent Home and a pinned LoopIQ build;
- no interactive credential prompt is possible;
- the Harbor job has a finite agent-phase timeout, the supervisor has a shorter
  inner deadline, and normal Runs settle before either expires;
- `environment.delete: true` is configured, cleanup errors are retained, and
  no process remains after verified teardown;
- every trial has exactly one adapter terminal manifest; a normally settled Run
  has exactly one correlated native terminal, while a forced/startup-failure
  path explicitly records a missing native terminal;
- normally completed stdout contains parseable, versioned events with a
  complete terminal record, while pre-Run and forced failures remain
  reconstructable from the other evidence sources;
- stderr is retained separately and cannot corrupt JSONL;
- exit code, signal, timeout state, native terminal state, cleanup state, and
  verifier result are all recorded independently;
- separate/shared verifier ordering is explicit, and no Agent process can
  mutate the workspace while scoring;
- usage/cost is complete or explicitly marked partial/unknown;
- artifact size and redaction policies are enforced;
- success, Provider failure, tool failure, length termination, timeout, abort,
  large output, hard kill, and stale-state isolation have end-to-end tests.

## Known Initial Limitations

- The first adapter is local/container installed-agent execution only.
- It does not use the DevUI Server or SSE as its trace source.
- It does not support interactive OAuth bootstrap.
- It does not claim exact in-flight Run recovery.
- It does not emit ATIF until the versioned conversion fixtures pass.
- It relies on adapter process-group supervision plus explicitly configured
  Harbor environment cleanup as the final safety boundary until LoopIQ owns all
  background child processes and Run budgets.
