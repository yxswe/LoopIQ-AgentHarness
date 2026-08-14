# Harbor Local Evaluation Integration

**Status:** Phase 1 complete; Phase 2 core implemented, with immutable packaging
and a real Harbor container smoke trial still pending

**Reviewed:** 2026-08-12

**Initial transport:** LoopIQ CLI in one Harbor trial container

**Harbor compatibility reference:** [`harbor-framework/harbor` at `cc4b7be`](https://github.com/harbor-framework/harbor/commit/cc4b7be7c1ace2621b38c4e2e13ef736a9bc884f)

## Document Authority and Progress Rules

This document is the canonical development target for the
`feature/harbor-local-eval` branch. It reconciles the original CLI/Harbor product
plan with the implementation that already exists.

- `[x]` means the behavior exists in code and has proportionate tests or direct
  verification.
- `[ ]` means required work remains. A design description alone is not
  completion.
- Every implementation change that completes an item must change its checkbox
  to `[x]` in the same commit.
- `docs/architect.md` remains the high-level architecture map, while
  [`cli-headless-readiness.md`](cli-headless-readiness.md) remains the detailed
  current CLI behavior reference. If either current behavior changes, update
  those documents in the same change.
- This branch must not add a `loopiq harbor` command or make Agent, CLI, or
  Server depend on Harbor types.

## Product Boundary: Two Surfaces, One Execution Core

```text
Personal user -> loopiq chat --+
                              +-> CLI Run coordination -> Agent
Harbor -------> loopiq run  --+
                    |
                    +-> stable JSONL on stdout
                    +-> diagnostics on stderr
                    +-> deterministic process exit
                              |
                       Harbor adapter
                              |
                 manifest / future ATIF / verifier reward
```

`chat` and `run` are two product surfaces over the same Agent. Harbor is only a
machine consumer of `loopiq run`; it is not a new Agent mode.

- [x] CLI calls the normal `createAgent()` entry directly; Harbor does not use
  Server.
- [x] The Harbor adapter lives under `integrations/harbor`, outside Agent, CLI,
  and Server packages.
- [x] Agent owns Provider/tool turns, compaction, Session persistence, Run
  identity, abort, and native events without knowing Harbor schemas.
- [x] CLI owns command parsing, process coordination, output mapping, and exit
  status without owning Provider or Session internals.
- [x] Harbor owns trial scheduling, environment lifecycle, outer containment,
  artifact collection, verification, reward, and cleanup.
- [x] `chat` and `run` call one shared CLI Run coordinator for the
  subscribe/start/wait/unsubscribe sequence while retaining their different
  process lifetimes.

## Reconciled Differences from the Earlier Document

| Area | Required resolution |
| --- | --- |
| JSONL terminal | The current terminal is stable enough for the Phase 2 supervisor, but it does not yet contain complete duration, model identity, reason taxonomy, aggregate Agent usage, or output-truncation state. |
| Installation | The adapter checks out the supplied Git revision and builds it in the trial, but does not yet enforce a full commit SHA or use an immutable published package/image. |
| Secret-file permissions | The adapter uses temporary files and deletes them, but this repository does not explicitly enforce and test mode `0600` after Harbor uploads them. |
| Chat experience | Banner, basic commands, Ctrl-C abort, and generic tool progress exist; explicit `/abort` and richer operation summaries remain. |
| ATIF | Native LoopIQ JSONL and a Harbor manifest exist. `trajectory.json` and `SUPPORTS_ATIF = True` remain deliberately unimplemented. |

## 1. Command Surface

The target public surface is:

```text
loopiq --help
loopiq --version

loopiq chat
loopiq chat --session ID
loopiq chat --continue --workspace DIR

loopiq run "prompt"
loopiq run --stdin
loopiq run --stdin --format jsonl --workspace DIR --model PROVIDER/MODEL

loopiq sessions list
loopiq sessions delete ID

loopiq providers list
loopiq providers add ID
loopiq providers validate ID
loopiq providers remove ID

loopiq models list [PROVIDER]

loopiq config get
loopiq config set-model PROVIDER/MODEL
loopiq config set-thinking LEVEL
loopiq config set-provider-request [OPTIONS]
```

Contract and progress:

- [x] `loopiq` with no arguments displays help and does not create a Session.
- [x] Unknown commands, unexpected positionals, invalid option combinations,
  and missing required values produce a usage error instead of becoming a paid
  prompt.
- [x] No `--new` flag exists. Fresh execution is the default for `run`.
- [x] `chat` is the human interactive surface and lazily creates a Session only
  when the first message or a Session-dependent command needs it.
- [x] `run` is one-shot and non-interactive after its prompt has been supplied.
  It never starts login or waits for an authentication answer.
- [x] `run` accepts exactly one prompt source: positional text or bounded stdin.
- [x] `run` creates a fresh Session unless `--session` or `--continue` is used.
- [x] `--session` and `--continue` are mutually exclusive.
- [x] `--session` rejects `--workspace` because the persisted Session already
  owns its Workspace.
- [x] `--model` and `--thinking` are rejected when resuming instead of silently
  mutating or ignoring persisted Session configuration.
- [x] Provider, model, configuration, Session-list, and Session-delete commands
  are explicit management operations.
- [x] The standalone `sessions create` command and its option/test paths are
  removed; fresh Sessions are created only by `run` and `chat` flows.

## 2. CLI Responsibilities and Run Coordination

CLI has only three business responsibilities:

1. parse commands and validate input;
2. coordinate one Run for the process or one iteration of Chat;
3. render human or machine output.

The shared target sequence is:

```text
select or create Session
  -> subscribe
  -> start Run
  -> receive events
  -> obtain terminal result
  -> unsubscribe
  -> shut down Agent when the CLI process is done
```

- [x] CLI imports only the Agent application surface and has no direct
  `@loopiq/ai` or Harbor dependency.
- [x] Session selection/creation is shared by `chat` and `run`.
- [x] Both modes subscribe before starting the Run, await the terminal result,
  unsubscribe, and eventually shut down Agent.
- [x] Human, JSON, and JSONL output are selected through one renderer boundary;
  JSONL is ANSI-free and program-readable.
- [x] The CLI remains one concise adapter module rather than adding speculative
  controller/service/repository layers.
- [x] One small per-Run coordinator is used by both `runOnce()` and each Chat
  message without moving policy out of Agent or introducing generic framework
  layers.

## 3. Harbor Invocation Contract

The logical evaluation command is:

```bash
loopiq run \
  --stdin \
  --workspace . \
  --model "$LOOPIQ_MODEL" \
  --thinking high \
  --format jsonl
```

The instruction is redirected from a private temporary file; JSONL and stderr
are redirected directly to Harbor's log mount. Token and prompt contents must
never be interpolated into command arguments because arguments enter logs and
process listings.

Each trial uses a fresh OS environment and:

```text
HOME=/tmp/loopiq-home
```

This naturally isolates `~/.loopiq/agent.json`, credentials, Sessions, and
locks without adding `--agent-home`.

- [x] The adapter recreates a dedicated mode-`0700` Agent Home before setup.
- [x] Every task Run explicitly supplies Workspace and Provider/model and
  creates a fresh Session.
- [x] The adapter does not reuse developer configuration, credentials,
  Sessions, or locks.
- [x] The prompt and token travel through uploaded files and stdin redirection,
  not process arguments.
- [x] Prompt and token files are deleted through checked `finally` paths.
- [x] No public `--agent-home` option is introduced.
- [ ] Explicitly set and test mode `0600` for both uploaded secret/prompt files
  after they arrive in the trial environment.

## 4. Harbor Adapter and Supervisor Ownership

Implementation layout:

```text
integrations/harbor/
  loopiq.py
  supervisor.py
  test_supervisor.py
```

The class is loaded through:

```text
integrations.harbor.loopiq:LoopIQ
```

The import-path adapter intentionally does not modify Harbor's built-in
`AgentName` registry.

The adapter and supervisor own:

- installation and verification of one pinned LoopIQ revision;
- isolated credential setup and selected-model availability checking;
- one CLI process group per trial;
- direct stdout/stderr log files rather than another unbounded in-memory copy;
- an inner deadline and `SIGINT -> SIGTERM -> SIGKILL` escalation;
- removal of live descendants even after nominal CLI exit;
- native-stream validation and a normalized trial manifest;
- later conversion of native events to ATIF.

They must not own Provider calls, Session persistence, tool execution, context
compaction, event repair, or reward calculation.

- [x] The adapter requires a non-empty LoopIQ Git revision, performs a detached
  shallow checkout of that revision, builds the workspaces, and verifies the
  compiled CLI workspace entry directly. It does not assume npm creates a root
  `node_modules/.bin/loopiq` link for the private CLI workspace.
- [x] Setup uses Agent's normal `providers add` and `models list` operations.
- [x] The supervisor starts a new process session and manages the entire process
  group rather than only the CLI PID.
- [x] Inner timeout escalation is implemented as
  `SIGINT -> grace -> SIGTERM -> grace -> SIGKILL`.
- [x] Descendants remaining after a nominal CLI exit are detected and
  terminated; zombie-only entries are not treated as live mutators.
- [x] Supervisor exit `124` means inner timeout and `125` means supervision or
  protocol failure; otherwise the normalized CLI exit is preserved.
- [x] Supervisor tests cover a valid terminal, mismatched identity, timeout, and
  remaining-process cleanup.
- [ ] Until a package/image exists, require a full immutable commit SHA rather
  than accepting an arbitrary Git revision; then replace source checkout/build
  with a pinned immutable package or image and record its digest together with
  Node, task, verifier, and model identity.
- [ ] Run and automate a real clean-container Harbor smoke trial; current tests
  execute the local supervisor, not Harbor's complete lifecycle.

The pinned configuration shape remains:

```yaml
agent:
  import_path: integrations.harbor.loopiq:LoopIQ
  model_name: openai/gpt-5.2
  override_timeout_sec: 330
  kwargs:
    version: "<full-loopiq-git-sha>"
    inner_timeout_sec: 300
    shutdown_grace_sec: 10
  env:
    LOOPIQ_API_TOKEN: "${LOOPIQ_API_TOKEN}"
environment:
  delete: true
```

For local Docker evaluation through the developer's authenticated LiteLLM
Copilot proxy, use `litellm-copilot/gpt-5.6-sol` and pass the LiteLLM master key
as `LOOPIQ_API_TOKEN`. The Agent talks to
`http://host.docker.internal:4000/v1`; `localhost` would refer to the Harbor
trial container itself. LiteLLM owns upstream Copilot authentication, while the
Harbor trial stores only its isolated proxy credential. This path is local
Docker only and is not expected to work from a cloud sandbox.

## 5. Stable CLI JSONL Protocol

CLI owns one external protocol rather than serializing
`AgentEventEnvelope` directly:

```json
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"run_started"}
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"message_delta"}
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"tool_started"}
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"tool_completed"}
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"run_completed"}
```

Only this current shape is maintained. `schemaVersion: 1` creates an explicit
future compatibility boundary; it does not justify retaining multiple parsers
during current development.

Before a Run is accepted, `command_failed` is the terminal command record. Once
`run_started` exists, normal process control must produce exactly one matching
`run_completed`. A hard kill may prevent that terminal; the supervisor records
`nativeTerminal.state: "missing"` and never fabricates success.

- [x] JSONL uses CLI-owned event names, schema identity, Session/Run identity,
  source sequence, and no ANSI output.
- [x] `run_started` records Session, Run, Workspace, model, thinking level,
  timestamp, and CLI version.
- [x] Message deltas, completed messages, tool lifecycle, compaction, Provider
  response metadata, and lifecycle events are mapped explicitly.
- [x] Selected credential-bearing Provider header names are redacted before
  machine output.
- [x] Accepted Runs produce one `run_completed` during normal settlement;
  pre-acceptance failures use `command_failed`.
- [x] Current `run_completed` records Session ID, Run ID,
  `completed | failed | aborted`, stop reason, final message, error, and
  `partial | unknown` assistant-message usage.
- [x] The supervisor validates schema, identity, sequence monotonicity,
  supported status, terminal cardinality, and CLI-exit agreement without
  loading the full stream into memory.
- [x] Missing or invalid terminals are preserved in the Harbor manifest rather
  than repaired.
- [ ] Add the selected Provider/model identity directly to `run_completed`.
- [ ] Add Run duration to `run_completed` rather than leaving duration only in
  the supervisor manifest.
- [ ] Replace the current coarse reason with an Agent-owned taxonomy that can
  distinguish at least `natural`, `provider_error`, `length`, `deadline`, and
  `budget`.
- [ ] Move aggregate usage/cost ownership into Agent and include every Run
  inference, including compaction, while preserving `known | partial | unknown`.
- [ ] Add explicit output/artifact truncation state and limits to the terminal.
- [ ] Handle stdout backpressure and EPIPE deterministically without allowing a
  slow machine consumer to block or crash Agent execution.

## 6. Deadlines, Budgets, and Resource Limits

The target containment order is:

```text
Agent Run deadline
  < CLI graceful-shutdown deadline
  < Harbor supervisor inner timeout
  < Harbor trial/environment timeout
```

Harbor containment is not a substitute for Agent semantics. Token and cost
limits can only be evaluated after Provider usage arrives, so a request may
exceed a configured threshold slightly; the system must not claim strict
pre-reservation.

- [x] Harbor supplies an outer trial boundary and the process-group supervisor
  supplies a shorter inner boundary.
- [x] CLI maps SIGINT/SIGTERM to Agent abort when a Run handle exists.
- [ ] Add Agent-owned total Run deadline.
- [ ] Add Agent-owned maximum Provider-call count.
- [ ] Add Agent-owned maximum tool-call count.
- [ ] Add Agent-owned maximum internal Turn count.
- [ ] Add Agent-owned total output-byte limit.
- [ ] Add Agent-owned token and cost stop thresholds with documented bounded
  overshoot semantics.
- [ ] Add Session/Agent ownership for background process registration,
  cancellation, process-tree termination, and shutdown cleanup.
- [ ] Add a bounded CLI graceful-shutdown deadline between Agent and Harbor
  deadlines.
- [ ] Expose only real Agent Run-policy inputs through CLI; do not implement
  cosmetic CLI limits that Agent cannot enforce.

## 7. Credential Flow

Personal mode may use interactive authentication:

```bash
loopiq providers add github-copilot --auth-method oauth
```

Harbor initially supports only non-interactive API-token Providers. Setup must
fail before the task Run if authentication or model availability fails.

- [x] Personal CLI supports explicit OAuth and API-token setup through Agent.
- [x] Harbor takes `LOOPIQ_API_TOKEN` from its secret environment, uploads it,
  and feeds it through `providers add ... --token-stdin`.
- [x] Token values never appear in command arguments, JSONL, or the manifest.
- [x] Agent validates a candidate credential before durable persistence.
- [x] Setup queries model availability and rejects an unavailable selected
  model before the task Run.
- [x] Harbor rejects OAuth-only Providers for this milestone.
- [x] Normal `run` never starts interactive login or performs a credential
  validation preflight; actual Provider requests determine request-time auth.

## 8. Artifact Ownership

Target layout:

```text
/logs/agent/
  loopiq-events.jsonl
  loopiq-stderr.log
  loopiq-run-manifest.json
  trajectory.json
```

- `loopiq-events.jsonl` is CLI-owned native evidence.
- `loopiq-stderr.log` contains CLI diagnostics.
- `loopiq-run-manifest.json` is Harbor-adapter/supervisor owned because only
  that boundary knows signals, outer containment, and descendant cleanup.
- `trajectory.json` will be Harbor-adapter owned and derived from native events.
- Reward is verifier/Harbor owned and must not enter Agent or CLI.

- [x] Events, stderr, and manifest artifacts use the fixed paths above.
- [x] The supervisor records adapter/Harbor/LoopIQ identity, timestamps,
  duration, PID/exit/signal/timeout state, signals sent, process-group cleanup,
  terminal validation, and file size/SHA-256.
- [x] The adapter copies only bounded usage and terminal metadata into
  `AgentContext`, not the complete event stream.
- [ ] Enforce total artifact-size and redaction policies.
- [ ] Convert native events to validated ATIF `trajectory.json` inside the
  Harbor adapter.
- [ ] Set `SUPPORTS_ATIF = True` only after fixture and pinned-Harbor validation
  pass.

## 9. Personal Chat Experience

The Chat banner must make the active context visible, while Run progress should
summarize meaningful operations without exposing hidden reasoning.

- [x] Banner displays Workspace, Session, model, thinking level, and local
  credential state.
- [x] Chat supports `/help`, `/sessions`, `/new`, `/model`, `/thinking`, and
  `/exit`.
- [x] Ctrl-C aborts an active Run and exits when waiting at the prompt.
- [x] Basic progress displays tool start and context compaction.
- [ ] Add an explicit `/abort` command in addition to Ctrl-C.
- [ ] Improve human progress to show concise operation-specific summaries such
  as `Thinking...`, `Running Bash: npm test`, and `Editing src/app.ts` without
  dumping full sensitive tool arguments.
- [ ] Define and implement input accepted during an active Chat Run as Agent
  steering. Machine `run` must remain non-interactive.

## 10. Implementation Sequence

The checkboxes in sections 1-9 are authoritative. This table is only a phase
summary.

| Phase | Goal | Status |
| --- | --- | --- |
| 1. Honest CLI contract | Executable bin, help/version, strict grammar, visible errors, cleanup/exit codes, real process tests | Complete |
| 2. Harbor smoke evaluation | Pinned installation, isolated HOME, non-interactive setup, stable JSONL, supervisor, manifest, `SUPPORTS_ATIF = False`, real container smoke | In progress: core implemented; immutable artifact, explicit `0600`, and real smoke remain |
| 3. Reliable evaluation | Agent deadlines/budgets, background-process ownership, complete usage/cost, bounded output/backpressure, failure/timeout/kill E2E coverage | Not started |
| 4. ATIF | Harbor-side conversion and validation, then `SUPPORTS_ATIF = True` | Not started |

Phase 3 must include end-to-end fixtures for success, Provider failure, tool
failure, length termination, timeout, abort, large output, hard kill, and full
teardown. Phase 4 must validate `ATIF-v1.7` against the pinned Harbor models.

## Current Non-goals

- No `loopiq harbor` command.
- No Harbor types or ATIF schemas in Agent or CLI.
- No Server transport for the initial local/container evaluation.
- No OAuth-only Provider in the first Harbor integration.
- No native resume of an in-flight evaluation Run.
- No fabricated terminal event after hard kill.

A future Server transport is considered only if a concrete evaluator requires a
warm remote Agent, concurrent admission, managed cancellation, or durable
reconnect. It must reuse the same Agent and native event semantics rather than
create an evaluation-specific runtime.
