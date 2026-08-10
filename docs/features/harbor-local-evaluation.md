# Harbor Local Evaluation Integration

**Status:** Phase 0 adapter implemented; end-to-end Harbor container smoke pending

**Reviewed:** 2026-08-10

**Initial transport:** LoopIQ CLI in one Harbor trial container

**Harbor compatibility reference:** [`harbor-framework/harbor` at `cc4b7be`](https://github.com/harbor-framework/harbor/commit/cc4b7be7c1ace2621b38c4e2e13ef736a9bc884f)

## Decision

Harbor invokes one LoopIQ CLI process per trial through a Harbor installed-agent
adapter. The integration does not add a LoopIQ Server, another Agent runtime, or
Harbor types to `packages/agent` or `packages/cli`.

This command boundary already exercises the real Agent composition root,
Session persistence, Provider selection, tools, context compaction, events, and
shutdown. Harbor owns scheduling, the trial environment, the outer timeout,
verification, result collection, and environment deletion.

## Implementation Layout

```text
integrations/harbor/
  loopiq.py              Harbor import-path installed-agent adapter
  supervisor.py          in-container CLI process-group supervisor
  test_supervisor.py     protocol, timeout, and process-group tests
```

The adapter class is loaded with:

```text
integrations.harbor.loopiq:LoopIQ
```

The LoopIQ repository root must therefore be on the Harbor host's Python import
path. The first integration intentionally uses Harbor's import-path support and
does not add LoopIQ to Harbor's built-in `AgentName` registry.

The adapter targets the pinned Harbor revision above, declares
`SUPPORTS_ATIF = False`, and does not support native resume. `packages/ai`
remains read-only and is consumed only through the Agent.

## Ownership

| Owner | Responsibilities | Must not own |
| --- | --- | --- |
| Harbor | Trial scheduling, environment lifecycle, outer timeout, verifier, result collection, cleanup | LoopIQ Session or turn semantics |
| LoopIQ Harbor adapter | Pinned install, isolated Agent Home, credential bootstrap, CLI supervision, log capture, normalized manifest | Provider/tool loop, scoring, or a second Agent |
| LoopIQ CLI | Construct Agent, select one Session, run once, map events and terminal status, shut down resources | Container lifetime or benchmark policy |
| LoopIQ Agent | Provider/tool turns, context compaction, persistence, Run identity, abort, native events | Harbor schemas, artifacts, or scheduling |
| Verifier | Inspect the final Workspace and calculate reward | Agent lifecycle or trace repair |

## Trial Flow

```text
Harbor creates the trial environment
  -> adapter installs one pinned LoopIQ git revision
  -> adapter creates /tmp/loopiq-home
  -> adapter supplies one API token through a mode-0600 temporary file
  -> loopiq providers add ... --token-stdin verifies and persists the credential
  -> adapter uploads the instruction as a mode-0600 temporary file
  -> supervisor starts one LoopIQ CLI process group
  -> CLI creates Agent + fresh Session + one Run
  -> CLI writes versioned JSONL and one run_completed terminal
  -> supervisor validates the stream and terminates any remaining process group
  -> supervisor writes one run manifest
  -> Harbor synchronizes logs and runs the verifier
  -> adapter backfills the small AgentContext summary from the manifest
  -> Harbor records cleanup and deletion results
```

The Harbor agent-phase timeout is the outer safety boundary. The supervisor's
inner timeout must be shorter so it can request graceful abort, capture the
outcome, and write its manifest before Harbor stops the phase.

## Harbor Configuration Shape

A job or trial config uses the import-path adapter and places the immutable
LoopIQ git revision in adapter kwargs:

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

Run Harbor from a Python environment compatible with the pinned Harbor
revision and make this repository importable, for example by setting
`PYTHONPATH` to the LoopIQ repository root. The exact task, environment type,
model, image, verifier mode, and network allowlist remain benchmark choices.

## Installation and Credential Bootstrap

The adapter requires a full git revision, clones only that revision into the
trial environment, runs `npm ci` and `npm run build`, and exposes the resulting
`loopiq` executable. It installs Node 22 through Harbor's Node helper and
requires `python3` and `procps` for supervision.

Each trial uses:

```text
HOME=/tmp/loopiq-home
```

This isolates `agent.json`, `credentials.json`, Sessions, and locks from the
developer and other trials. The first adapter supports API-token Providers only:

1. Harbor resolves `LOOPIQ_API_TOKEN` from its host environment.
2. The adapter uploads it as a private temporary file.
3. `loopiq providers add PROVIDER --auth-method api_token --token-stdin` reads
   the token from stdin, verifies it through Agent, and persists it only after
   successful verification.
4. `loopiq models list PROVIDER --refresh --format json` verifies that the
   selected model is advertised by the configured Provider.
5. The adapter deletes the temporary token file in a checked `finally` path.

The secret is never placed in the shell command, JSONL stream, or manifest.
OAuth-only `openai-codex` and interactive OAuth/device flows are rejected for
this milestone.

## CLI Invocation

The supervised logical command is:

```bash
loopiq run \
  --stdin \
  --workspace . \
  --model "$LOOPIQ_MODEL" \
  --thinking high \
  --format jsonl \
  < /tmp/loopiq-instruction.txt \
  > /logs/agent/loopiq-events.jsonl \
  2> /logs/agent/loopiq-stderr.log
```

The instruction and token are uploaded files because Harbor's environment
`exec()` contract does not provide a streaming stdin handle. The instruction is
not interpolated into a logged shell command. Provider request-policy flags are
not passed to `run`; persistent Agent configuration is their current owner.

## Supervisor Contract

`supervisor.py` is invoked through `python3`, creates a new process session, and
redirects CLI stdout/stderr directly to files. This avoids retaining another
unbounded copy in Harbor's `ExecResult`.

On the inner deadline it applies:

```text
SIGINT -> grace -> SIGTERM -> grace -> SIGKILL
```

`SIGINT` gives the CLI a chance to call `Agent.abort()` and settle. Later
signals contain a non-responsive CLI and its descendants. After every parent
exit, including a nominal success, the supervisor inspects the process group;
remaining live descendants receive `SIGTERM` and then `SIGKILL` if required.
Zombie-only process-group entries are not treated as live Workspace mutators.

The supervisor validates the versioned JSONL stream without retaining it in
memory. It checks:

- every parsed event is an object using `loopiq.cli.event` schema version `1`;
- at most one `run_started` and one `run_completed` are present;
- a terminal has a matching accepted Session and Run identity;
- mapped Agent source sequences are strictly increasing;
- the terminal status is supported;
- successful process exit agrees with a completed terminal.

Startup failures may contain `command_failed` without a Run terminal. A timeout
or hard kill may leave the terminal missing. Invalid schema, identity,
sequencing, or exit/terminal agreement makes the supervisor exit `125` while
preserving the evidence in the manifest.

Supervisor exit codes reserve `124` for the inner deadline and `125` for a
supervision/protocol failure. Otherwise the normalized CLI exit code is
preserved.

## Artifacts and Manifest

The adapter writes stable files in Harbor's Agent log mount:

```text
/logs/agent/
  loopiq-events.jsonl
  loopiq-stderr.log
  loopiq-run-manifest.json
```

The manifest uses `loopiq.harbor.run_manifest` schema version `1` and records:

- adapter version and Harbor compatibility revision;
- Harbor agent-session and durable trial-context identity;
- LoopIQ revision, model, CLI version, and CLI event schema;
- start/end timestamps and duration;
- CLI PID, return code or signal, inner-timeout state, sent signals, and
  remaining-process-group cleanup state;
- native `run_started` and `run_completed`, parsed event count, validation
  error, and exit/terminal mismatch;
- byte size and SHA-256 digest for JSONL and stderr;
- supervisor failures.

The raw stream is evidence, not the only authority. Harbor separately records
its outer timeout, environment stop/delete result, and verifier result.

After logs are synchronized to the host,
`populate_context_post_run()` copies only usage totals and small metadata into
`AgentContext`. It does not put the full event stream or transcript there.
Usage remains explicitly `partial` or `unknown` because context-compaction
inference is not yet included.

## Current Limitations

- A real Harbor container smoke trial and clean-machine installation test are
  still required; the local suite currently tests the supervisor itself.
- The adapter builds from a pinned source revision rather than a published
  immutable package/image artifact.
- The Agent has no Run-wide deadline or work budget; Harbor and the supervisor
  provide containment, not equivalent Agent semantics.
- CLI stdout backpressure, EPIPE, total artifact limits, and full content
  redaction profiles are not complete.
- Agent shutdown does not own background Bash processes; the process-group
  supervisor is the evaluation containment boundary.
- Usage excludes context-compaction inference and retry/timing/tool-resource
  observability is incomplete.
- The first adapter is local/container execution only and does not resume an
  in-flight Run.
- No ATIF trajectory is emitted.

## Next Phases

### Phase 1 — Reliable Evaluation Boundary

- add Agent-owned Run deadlines and count/output budgets;
- complete aggregate Run usage including compaction;
- make event delivery, stdout backpressure, EPIPE, and shutdown bounds
  deterministic;
- enforce artifact size and redaction policies;
- add end-to-end Harbor fixtures for success, Provider failure, tool failure,
  length termination, timeout, abort, large output, hard kill, and teardown;
- pin the Harbor runtime, LoopIQ build/image, Node runtime, task, verifier, and
  model in the produced evaluation record.

### Phase 2 — Standardized Trajectories

Convert the stable LoopIQ-native stream to `ATIF-v1.7` inside the Harbor adapter,
validate the generated `trajectory.json` against the pinned Harbor models, and
only then set `SUPPORTS_ATIF = True`. Agent and CLI must not import ATIF types.

### Phase 3 — Server Transport Only If Required

Use the existing Server only when a concrete evaluator requires a warm remote
Agent, concurrent admission, managed status/cancellation, or durable reconnect.
That path first requires bounded replay, cursors/gap semantics, non-blocking
subscribers, and terminal delivery guarantees. It must reuse the same Agent and
native event semantics rather than create an evaluation-specific runtime.
