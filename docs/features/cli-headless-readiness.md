# CLI and Headless Evaluation Readiness

**Status:** Review complete; implementation work is not started

**Reviewed:** 2026-08-05

**Applies to:** `packages/cli` and the Agent runtime paths exercised by the CLI

## Decision Summary

The CLI is a usable development entrypoint and can execute a multi-turn coding
task. It is not yet a production-grade long-running task runner or a fully
reliable external evaluation boundary.

Today, `loopiq run` can create or open a Session, stream Agent events, execute
multiple Provider/tool turns, and compact model context. After `agent.run()` has
returned a handle, its first `SIGINT` requests a foreground Run abort. If
rendering and shutdown also succeed, a settled Run maps to a defined exit code.
Those capabilities are sufficient for an initial, container-supervised Harbor
diagnostic smoke trial, not yet a trustworthy repeatable benchmark.

They are not sufficient to claim bounded, resumable, or unattended long-task
support. There is no Run-wide deadline or work budget, some accepted CLI flags
have no effect, background commands are not owned by the Agent lifecycle, large
output can grow process memory, and an interrupted process cannot resume an
in-flight Provider request or tool call.

The initial Harbor integration must therefore treat the CLI as a child process
inside one disposable trial container and one disposable OS home. The Harbor
job must explicitly configure a finite agent-phase timeout and environment
deletion; neither should be assumed from defaults. The isolated home prevents
cross-trial `~/.loopiq` configuration, credential, Session, and lock state.

## Scope and Related Documents

This review covers:

- command parsing and option ownership;
- one-shot and interactive Run lifecycle;
- exit status, signals, shutdown, and process ownership;
- JSON/JSONL output and trace usefulness;
- memory and persistence behavior during long Runs;
- packaging and automated test coverage relevant to external evaluators.

The runtime ownership model remains defined by:

- [`../architect.md`](../architect.md);
- [`../techniquedocs/agent-run.md`](../techniquedocs/agent-run.md);
- [`../techniquedocs/agent-runtime.md`](../techniquedocs/agent-runtime.md);
- [`../techniquedocs/context-management.md`](../techniquedocs/context-management.md);
- [`../techniquedocs/multi-session-runtime.md`](../techniquedocs/multi-session-runtime.md).

The existing roadmap already identifies overlapping work in
[`../roadmap.md`](../roadmap.md), especially "Background task management",
"CLI & headless entrypoint", and "Run usage and reliable Session event
delivery". This document makes the CLI-specific gaps and acceptance order
explicit; it does not mark those roadmap items complete.

## Current One-Shot Flow

For `loopiq run`, the current implementation performs this sequence:

1. `parseArgs()` parses all command-line tokens into one shared option object.
2. `runOnce()` reads the complete prompt, then calls `createAgent()`.
3. The CLI creates a new Session unless `--session` selects an existing one.
4. It subscribes a text or JSONL renderer before starting the Run.
5. It applies model and thinking overrides, starts one Run, and waits for its
   `RunResult`.
6. It maps completed, failed, and aborted results to process exit codes, removes
   its `SIGINT` listener, unsubscribes, and calls `agent.shutdown()`.

`AgentRun` may execute any number of Provider/tool turns. Before a next Provider
request, the context manager attempts to compact history when estimated use
reaches a fixed 90% of the model context window, targeting 50% with at most 4096
summary tokens. Compaction can fail as uncompactable or for other summarization
reasons. It is not a Run work budget and does not bound elapsed time, total
inference tokens, total tool calls, output volume, or cost.

## Findings

Priority meanings in this document are:

- **P0:** must be fixed or explicitly mitigated before a trustworthy unattended
  evaluation; a pinned raw-log diagnostic MVP may proceed with the mitigations
  documented in the Harbor plan;
- **P1:** required before production long-running or broadly scriptable use;
- **P2:** usability, maintainability, or later interoperability improvement.

### P0 — Configuration-Only Request Flags Are Accepted and Ignored by Runs

**Evidence:** `parseArgs()` stores `--transport`, `--timeout-ms`,
`--max-retries`, `--max-retry-delay-ms`, and `--cache-retention` in
`ParsedOptions.providerRequest`. `runOnce()` and `runChat()` never read that
field. Only the `config set-provider-request` branch of
`runManagementCommand()` applies it.

This means a command such as:

```text
loopiq run --timeout-ms 60000 --max-retries 0 --stdin
```

is accepted but does not configure that Run. This is more dangerous than an
unsupported option because an evaluator can incorrectly believe that a limit
was enforced.

**Required change:** reject Provider-request flags on `run`, `chat`, and other
non-configuration commands. The only current owner is the persistent Agent
configuration command. Design a Run-local policy and its precedence later only
if a concrete caller requires that choice; do not add a speculative forwarding
path through the current Agent API.

`packages/ai` is an externally sourced, read-only dependency. Provider-specific
policy gaps, including the current Google timeout/retry behavior, must be
resolved through an upstream dependency update or an integration owned by a
consuming package; they must not be patched inside `packages/ai` in this
repository.

### P0 — A Run Has No Total Work or Resource Guardrail

**Evidence:** `AgentRun.runLoop()` continues while tool calls or steering remain.
There is no Run-wide deadline, maximum turns, Provider calls, tool calls,
elapsed time, cumulative tokens, cumulative cost, or memory budget. The default
Provider policy passes a compiled default of `timeoutMs = 300000` and
`maxRetries = 0` to each request. Only Provider transports that consume those
fields enforce the timeout; the current Google transports do not. Even when a
transport enforces every request limit, an unlimited sequence of individually
bounded requests can still run indefinitely. Foreground Bash also has no
timeout unless the model supplies one.

**Impact:** a looping model, repeated tool use, a hung command, or repeated
context compaction can consume an entire CI worker or evaluation slot. A finite
Harbor agent-phase timeout must be configured as an external safety net; its
availability is not proof that the CLI itself supports bounded long tasks.

**Required change:** add an Agent-owned Run execution policy with a hard
deadline and hard count/output budgets. Token and cost thresholds can only stop
future work after Provider-reported accounting arrives, so they must expose
unknown/partial and possible overshoot semantics rather than claim a strict
pre-consumption cap. The terminal result and event stream must identify which
policy ended the Run. Configure the Harbor agent-phase timeout slightly larger
than the adapter supervisor's deadline so the CLI normally settles and writes
its terminal logs before forced environment cleanup.

### P0 — Output and Event Delivery Can Grow Memory Under Load

Several layers compound high-output behavior:

- `NodeExecutionEnv.exec()` accumulates complete stdout and stderr even though
  `executeShellWithCapture()` separately keeps a bounded tail and spills output
  to a file.
- `Bash.execute()` grows `streamed` for every chunk and emits the complete
  accumulated partial result on every tool update.
- `executePreparedToolCall()` retains a Promise for every update until the tool
  ends.
- the CLI calls `stdout.write()` without honoring its boolean backpressure
  result or awaiting `drain`.
- stdout has no controlled `error`/EPIPE path, so a closed downstream pipe can
  terminate outside normal cleanup.
- `readStdin()` concatenates the complete input before Agent construction.
- context compaction replaces model-visible history, but `AgentRun.newMessages`
  retains every prompt, steering message, assistant message, and tool result
  produced by the current Run for `RunResult.messages`.
- opening a Session reads its complete JSONL file and retains all entries plus a
  full ID index; context compaction does not release older store entries.

For a long command with many chunks, the repeated cumulative tool updates can
also make emitted JSONL volume approach quadratic growth relative to the raw
command output.

`AgentSession` currently awaits each listener serially, and the streaming path
awaits event emission. Simply awaiting stdout `drain` would therefore propagate
a slow consumer into Provider progress and Run settlement. Not awaiting it, as
today, permits the Node stdout buffer to grow.

**Required change:** bound capture at the environment owner, emit incremental
or sampled tool updates, and define a bounded ordered per-subscriber delivery
and overflow policy. Make CLI output drain-aware without making observer speed
part of core Run correctness. Define controlled EPIPE behavior, input and
artifact size limits, and truncation reporting rather than relying on heap
exhaustion.

### P0 — Background Commands Are Outside Agent Ownership

**Evidence:** `Bash` starts a background command by calling `env.exec()` without
the Run abort signal or a timeout. It returns a generated ID and log path, but
no registry owns that ID. `NodeExecutionEnv.cleanup()` is a no-op, and the
spawned child keeps piped stdio and is not `unref()`ed.

**Impact:** a background command can keep the CLI process alive after its Run
settles, survive a normal Agent shutdown, or become orphaned when the evaluator
kills the CLI. The returned path can be polled through generic Read or Bash
operations, including Read offsets, but there is no task-scoped list/status/exit
API, stable log cursor, cancellation, or retention policy.

**Required change:** implement the session-scoped background task manager
already described in the roadmap. There is no current evaluation-profile switch
that can disable background Bash. Until an enforceable tool policy exists, the
initial benchmark can only advise against its use; the model may still select
it. Process-group supervision and forced environment cleanup must remain the
final safety boundary.

### P0 — Provider Length Termination Is Reported as Success

**Evidence:** `AgentRun.execute()` maps only `stopReason === "aborted"` to
aborted and `stopReason === "error"` to failed. Every other final assistant
stop reason, including `"length"`, becomes `status: "completed"`; the CLI then
exits with code `0`.

**Impact:** an evaluator can score an output truncated by the model limit as a
successful Agent completion.

The full assistant message already preserves `stopReason` in JSON output and in
JSONL `message_end`. Status-only consumers, `run_settled`, and the process exit
code lose that distinction.

**Required change:** define terminal semantics for every Provider stop reason,
promote a typed terminal reason to the top-level Run/settlement contract, and
make a length-truncated result distinguishable from a successful natural stop
without reconstructing it from message history.

### P0 — The JSONL Stream Is Not Yet a Stable Evaluation Contract

JSONL mode directly serializes internal `AgentEventEnvelope` objects. The
envelope already provides valuable `sessionId`, `runtimeId`, `runId`, sequence,
timestamp, message lifecycle, and tool lifecycle data. However:

- there is no CLI output schema name or version;
- the existing terminal `run_settled` contains status and error only, not a
  complete terminal `RunResult`, final stop reason, aggregate usage, cost, or
  truncation state;
- usage is attached to individual assistant messages rather than aggregated
  across the Run;
- the inference used for context compaction is not represented in Run usage or
  cost;
- request retries, request latency, queue time, and tool duration are not a
  complete correlated metric contract;
- failures before a Run is accepted are emitted as plain stderr even in JSON or
  JSONL mode;
- `model_update` serializes internal current and previous `@loopiq/ai` Model
  objects directly, increasing external-schema coupling and the redaction
  surface beyond Provider response headers;
- Provider/auth failures inside an accepted Run can settle with error code
  `unknown` and exit `1`, while similar top-level setup errors use the Provider
  exit-code category;
- header redaction covers a small explicit set, while tool arguments, tool
  results, model content, paths, and environment-derived data require a defined
  artifact policy.

**Required change:** introduce a versioned external CLI event contract and make
`run_settled`, or its versioned replacement, a complete terminal record for
every accepted Run. Add a structured command-level failure record for errors
before Run acceptance. Aggregate every inference attributable to the Run,
including context compaction, with explicit unknown and partial accounting.
Retain raw internal events only as a separately labelled diagnostic artifact.

### P1 — Cleanup Ownership Starts After Fallible Setup

`runOnce()` enters its `try/finally` only after Session selection, renderer
subscription, Session overrides, and Run start. `runChat()` likewise selects
and updates the Session before entering its cleanup boundary. If any of those
steps fails after the Session lease is acquired, `agent.shutdown()` is skipped.

For example, opening an existing Session and then failing to apply an invalid
model override can leave that Session's `runtime.lock` behind. The next process
then reports `session_locked` even though no runtime is alive.

**Required change:** immediately enter an outer `try/finally` after
`createAgent()` succeeds. Track the subscription, readline interface, and Run
handle as optional owned resources, and always call
`agent.shutdown({ abortRunning: true })` for setup, execution, rendering, and
shutdown-error paths.

### P1 — Signal Handling Does Not Cover the Process Lifecycle

`runOnce()` installs a handler only for `SIGINT`, and only after Agent creation,
Session selection, renderer attachment, override application, and Run start.
The first signal requests `agent.abort()` without awaiting or reporting an abort
failure. A second `SIGINT` calls `process.exit(130)`, bypassing `finally` and
Agent shutdown. `SIGTERM` is not handled. `runChat()` has no explicit active-Run
signal policy. Management commands do not connect signals to credential
interactions, so canceling a secret or OAuth flow can be classified as a
Provider credential setup failure instead of a process cancellation.

**Required change:** use one process-lifecycle controller for `SIGINT` and
`SIGTERM`, make graceful shutdown time-bounded, terminate owned process trees,
and reserve forced exit for an explicit grace-period expiry or second signal.
Document exit codes for signal-before-run, graceful abort, forced termination,
and shutdown failure.

### P1 — Crash Recovery Restores History, Not an In-Flight Run

Complete messages and compaction records are appended to the Session JSONL log.
An abrupt process loss does not checkpoint Provider stream state, active tool
state, steering state, or an accepted Run terminal status. Reopening a Session
can restore committed history but cannot resume the exact in-flight Run.

The per-Session `runtime.lock` stores a PID but does not inspect it or recover a
stale lease. A hard-killed process can therefore make the Session fail to open
until the lock file is removed manually. The append-only store also reads and
indexes the complete JSONL file when opened and retains all historical entries,
including entries made invisible by context compaction.

**Required change:** first make stale lease recovery safe and deterministic.
Then define crash semantics: either explicitly mark abandoned Runs and start a
new Run from the last committed boundary, or design resumable execution. Do not
claim in-flight resume while only conversation history is recoverable. Add a
Session storage compaction/index strategy for genuinely long-lived Sessions.

### P1 — CLI Mode and Option Grammar Is Too Permissive

The parser accepts most flags for every command and rejects very few unused
positional arguments. Consequences include:

- `sessions create --session EXISTING` is accepted and calls `getSession()`
  through the shared selector, so a command named `create` can return an
  existing Session instead of creating one;
- management commands can accept irrelevant flags or extra positional tokens
  and then ignore them;
- `chat` accepts a positional prompt and `--stdin`, but `runChat()` does not use
  either as an initial message;
- `--new` is used only to reject its combination with `--session`; it never
  changes Session selection, and omitting `--session` already creates a new
  Session;
- `run` or `chat` accepts `--session S --workspace X`, but Session selection
  opens `S` and silently ignores `X`;
- `options.model` defaults from `LOOPIQ_MODEL`; when resuming a Session, that
  environment-derived value is indistinguishable from an explicit `--model`
  and can persistently update the Session model;
- `--thinking`, Provider transport, cache retention, and integer ranges are not
  consistently validated at the command boundary;
- the same invalid usage can exit as `1`, `2`, or `4` depending on whether it is
  rejected by the parser, Agent settings, or Session persistence;
- options that appear before the command are not parsed as global options; for
  example, `loopiq --format json sessions list` becomes a default `run` prompt
  and may unexpectedly start a paid inference;
- there is no `--` end-of-options delimiter for prompt text beginning with
  `--`.

**Required change:** define a command-specific grammar and validate every option
at parse time. Every accepted value must have one owner and observable effect.
Reject unused options and extra arguments. Make `sessions create` call
`createSession()` directly. Decide whether `chat` supports an initial prompt,
whether options can precede commands, and whether `--new` is required, optional
documentation, or removed. Define flag, environment, Agent-default, and resumed-
Session precedence, including whether a CLI model/thinking override is durable
or Run-local. Introduce a CLI-owned typed usage error, reserve exit code `2` for
that type only, and reserve exit code `4` for real Session access or storage
failures.

### P1 — Human-Readable Failures Can Be Silent After Run Acceptance

In text mode, the renderer prints text deltas only. If the Run settles as failed,
`runOnce()` returns exit code `1` but does not print the `RunResult.error` to
stderr. `runChat()` does not branch on an individual Run status and ultimately
returns `0` after the user exits. Pre-Run exceptions use plain stderr and a
different exit-code mapping in the top-level catch.

The current mapping is:

| Current condition | Exit code |
| --- | --- |
| Settled `completed` Run | `0` |
| Settled `failed` Run | `1` |
| Settled `aborted` Run or observed one-shot `SIGINT` | `130` |
| Top-level `session` or `session_locked` Agent error | `4` |
| Top-level `provider_*` or `credential_store` Agent error | `3` |
| Other top-level Agent runtime error | `1` |
| Any top-level non-Agent error, including usage and possible adapter/internal errors | `2` |

An accepted-Run Provider or authentication failure normally appears as a
settled failed Run and therefore exits `1`, not the top-level Provider category
`3`.

**Required change:** define one outcome-to-exit-code table covering management,
pre-Run, one-shot, and chat paths. Decide whether chat exits on the first failed
Run, remembers any failure, or uses another documented aggregate policy. Text
mode must print a concise terminal diagnostic to stderr; machine modes must emit
a structured terminal failure whenever stdout remains usable. Only the typed
usage-error category should map to `2`; unexpected adapter/internal errors must
map to `1`. Define cleanup precedence as well: JSON output is currently written
before `agent.shutdown()`, so a shutdown exception can leave a completed record
on stdout and then replace its intended exit code with top-level code `2`.

### P1 — Distribution Is Not Reproducible for an External Adapter

`@loopiq/cli` is private and points its executable at a built `dist/cli.js`.
`@loopiq/agent` is private and currently has no package version. A Harbor adapter
can build the monorepo from a pinned commit, but it cannot yet install a normal,
versioned LoopIQ release artifact and report that artifact identity in a trace.

**Required change:** choose a supported installation contract: a versioned npm
package, a standalone archive/binary, or a pinned source-build image. Record
LoopIQ version, source revision, Node version, and adapter version in every
evaluation artifact.

### P1 — End-to-End CLI Behavior Is Largely Untested

`packages/cli/src/cli.test.ts` tests argument parsing only. It does not spawn the
real executable or cover stdout/stderr separation, exit codes, JSONL ordering,
slow output consumers, closed pipes, signals, foreground/background commands,
hard termination, stale locks, or crash/restart behavior.

**Required change:** use the existing internal `createAgentForTesting()` seam for
deterministic Agent tests and separately exercise the real built executable,
signals, pipes, and container lifecycle. Do not add a public production
constructor injection solely for CLI tests. Include real child-process signal
tests on supported platforms and container-level tests for process-tree cleanup.

### P2 — Basic CLI Discoverability Is Missing

There is no built-in `--help` or `--version`. Unsupported commands can also be
interpreted as the default `run` prompt because `run` is the fallback command.
This is workable for development but weakens scripting diagnostics and artifact
identity.

**Required change:** add generated help, version output, examples, and an
explicit policy for commandless prompt shorthand.

### P2 — Equivalent Run Modes Produce Different Configuration Traces

When an existing Session is resumed and a model or thinking override actually
changes it, one-shot `run` subscribes before applying the override, while
`chat` applies it before subscribing. The same adapter-caused configuration
change is therefore present in one JSONL trace and absent from the other. New
Sessions receive their configuration during creation and emit no equivalent
update in either mode.

**Required change:** choose one event ordering for adapter-applied mutations,
prefer subscribing before them, and cover the ordering with process-level
fixtures.

## Long-Running Task Support Matrix

| Capability | Current state | Assessment |
| --- | --- | --- |
| Multiple Provider/tool turns | Supported | The core loop continues until no tool calls or steering remain. |
| Model-context compaction | Supported | Attempts compaction at a fixed 90% of the model window toward 50%; it can fail and does not bound process resources or total work. |
| Per-Provider-request timeout | Partially supported | The compiled default passes 300 seconds to each request; CLI `run` flags do not override it, and only Provider implementations that consume the policy enforce it. The current Google transports do not enforce the shared timeout/retry fields. |
| Foreground tool cancellation | Partially supported | Run abort reaches foreground tools; termination remains dependent on environment/process-tree behavior. |
| Run-wide deadline and work budget | Missing | The Harbor job must explicitly configure its optional agent-phase timeout today. |
| Output and memory bounds | Missing end-to-end | Some tool-result tails are bounded, but lower layers and delivery queues can still grow. |
| Background task lifecycle | Missing | Background processes are untracked and survive normal Run ownership. |
| Graceful `SIGTERM` shutdown | Missing | Important for containers and CI cancellation. |
| Durable completed history | Supported | Complete Session entries are append-only JSONL. |
| Stale Session lease recovery | Missing | A hard kill can leave `runtime.lock`. |
| In-flight Run resume | Missing | Only committed history is recoverable. |
| Aggregate Run usage/cost | Missing | Per-message usage is insufficient for accurate evaluation accounting. |
| Versioned trace schema | Missing | Current JSONL is an internal event serialization. |

## Implementation Plan

### Phase 0 — Make the Existing Contract Honest

- Scope flags by command and reject every unsupported or ignored combination.
- Reject Provider request-policy flags outside
  `config set-provider-request`; defer any Run-local design until a concrete
  caller owns that choice.
- Move setup under an Agent-owned cleanup boundary and make `sessions create`
  unconditionally create.
- Correct terminal status mapping for `length` and all other stop reasons.
- Validate usage before Agent construction, print terminal errors consistently,
  and document the exit-code table.
- Add `--help`, `--version`, and artifact build identity.
- Add process-level smoke tests for text, JSON, JSONL, stdin, fresh Session, and
  existing Session flows.
- Prove that `sessions create --session S` is a usage error, a valid create
  returns a new ID, and a failed override on an opened Session leaves no lease
  that prevents an immediate reopen.

### Phase 1 — Make Execution Bounded and Container-Safe

- Add hard Run deadline, turn, Provider-call, tool-call, and output budgets plus
  accounting-based token/cost stop thresholds with typed terminal reasons.
- Implement unified `SIGINT`/`SIGTERM` handling and a bounded shutdown grace
  period.
- Implement owned background tasks or an enforceable evaluation tool policy
  that removes background execution.
- Bound environment capture and tool-update queues; honor stdout backpressure.
- Recover stale Session leases and define abandoned-Run markers.
- Test high-output, slow-consumer, timeout, abort, forced-kill, and process-tree
  cleanup paths.

### Phase 2 — Stabilize the Evaluation and Trace Surface

- Define a versioned CLI JSONL schema with a complete accepted-Run terminal
  record and a structured pre-Run command-failure record.
- Add aggregate Run usage and cost, including compaction inference.
- Add correlated timings and retry/tool lifecycle metrics.
- Define content redaction, raw-log retention, and artifact size policy.
- Publish or otherwise produce a reproducible installable artifact.
- Add compatibility fixtures so adapters can validate each supported schema
  version.

### Phase 3 — Add Recovery Only If Product Requirements Need It

- Decide whether restarting from the last committed message boundary is enough.
- If exact in-flight resume is required, design durable Run, Provider stream,
  tool, and idempotency state as one cohesive feature.
- Add Session log compaction/indexing and retention without weakening the
  append-before-publish invariant.

## Acceptance Criteria

The CLI can be called a reliable long-running evaluation entrypoint when all of
the following are true:

- every accepted flag has a tested observable effect;
- every Run has a configurable hard deadline and finite count/output budgets;
  accounting-based token/cost thresholds expose partial data and overshoot;
- every CLI-controlled terminal path produces one unambiguous status, reason,
  and exit code; forced process loss is represented by the outer supervisor;
- `SIGINT` and `SIGTERM` either settle the Run and clean up owned processes or
  reach a documented forced-termination deadline;
- a slow stdout consumer and a high-output command remain within tested memory
  bounds;
- no child process survives normal shutdown or trial cancellation;
- a hard-killed Session can be reopened safely with explicit abandoned-Run
  semantics;
- JSONL has a version, a complete terminal record for every normally settled
  accepted Run, a structured pre-Run failure record, and complete or explicitly
  partial Run accounting;
- process-level tests cover supported platforms and the Harbor container path.

## Test Matrix

| Area | Required cases |
| --- | --- |
| Parsing | every command/flag combination, range and enum validation, extra arguments, global-option ordering, `--`, initial chat prompt, create-vs-open semantics |
| Exit behavior | natural stop, length stop, Provider error, tool error, compaction failure, abort, pre-Run failure, shutdown failure |
| Signals | first and repeated `SIGINT`, `SIGTERM`, signals during setup/provider/tool/credential/shutdown, grace-period expiry |
| Streams | text/JSON/JSONL, stdout backpressure, EPIPE, large stdin, large tool output, invalid serialization |
| Processes | foreground timeout, abort-resistant child, background completion/cancel, process-tree cleanup, container kill |
| Persistence | normal reopen, crash after each append boundary, partial trailing record, stale lock, large Session open |
| Trace | monotonic sequence, identity correlation, configuration-event ordering, one complete terminal on settlement, explicit missing-native state after hard kill, pre-Run failure, schema fixture, usage/cost totals, redaction |
| Isolation | one disposable OS home and `~/.loopiq` per trial, no cross-trial credentials/configuration/Sessions/locks |
| Packaging | clean-machine install, pinned version/revision, executable discovery, supported Node versions |

## Out of Scope for the Initial Harbor Milestone

- a new LoopIQ evaluation Server;
- exact replay of a Provider stream after process loss;
- Harbor ATIF-native execution;
- multi-tenant scheduling or a persistent worker pool;
- treating DevUI SSE as a durable trace transport.

Those capabilities should be added only after the CLI child-process boundary is
bounded, observable, and reproducible.
