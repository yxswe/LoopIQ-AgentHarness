# CLI and Headless Evaluation Readiness

**Status:** Phase 0 CLI boundary implemented; runtime hardening remains

**Reviewed:** 2026-08-12

**Applies to:** `packages/cli` and the Agent paths exercised by the CLI

## Decision Summary

The CLI is both the personal terminal adapter and the first machine-facing
evaluation boundary. It invokes `Agent` directly; it does not require the HTTP
Server and it does not own Provider, Session, tool, or context-management
behavior.

The current CLI is suitable for interactive use, scripting, and an initial
container-supervised Harbor evaluation. It is not yet a self-contained
production runner for unbounded tasks. Run-wide deadlines and budgets,
background-process ownership, bounded subscriber delivery, stdout
backpressure, complete usage accounting, and crash recovery remain Agent or
cross-layer work.

The related Harbor lifecycle is specified in
[`harbor-local-evaluation.md`](harbor-local-evaluation.md). Agent runtime and
Session ownership remain defined by:

- [`../architect.md`](../architect.md);
- [`../techniquedocs/agent-run.md`](../techniquedocs/agent-run.md);
- [`../techniquedocs/agent-runtime.md`](../techniquedocs/agent-runtime.md);
- [`../techniquedocs/multi-session-runtime.md`](../techniquedocs/multi-session-runtime.md).

## Implemented Command Contract

`loopiq` uses explicit command groups and rejects unknown commands, unexpected
positionals, unsupported option/command combinations, and ambiguous Session
overrides with exit code `2`.

| Capability | Commands and behavior |
| --- | --- |
| Discovery | `loopiq`, `--help`, `--version`, and `--version --format json` |
| One shot | `run <prompt>` or `run --stdin`; non-interactive and fresh by default |
| Interactive | `chat [initial prompt]` with `/help`, `/sessions`, `/new`, `/model`, `/thinking`, and `/exit` |
| Session selection | `--session ID` selects one exact Session; `--continue` selects the most recently updated Session in the requested Workspace |
| Session management | `sessions list/delete`; Session creation belongs to `run` and `chat` |
| Models and Providers | local `providers list`, explicit `providers validate`, `providers add/remove`, and `models list [PROVIDER] [--refresh]`; unscoped listing includes only credential-backed Providers, while every included GitHub Copilot listing refreshes account availability |
| Non-interactive credential input | `providers add ID --token-stdin`; the token is read from stdin and is never placed in process arguments |
| Configuration | `config get`, `set-model`, `set-thinking`, and `set-provider-request` |
| Output | human text, one terminal JSON object, or a versioned JSONL event stream |

Provider request-policy flags are accepted only by
`config set-provider-request`. They are deliberately rejected by `run` and
`chat` because the Agent has no Run-local request-policy contract.

The first GitHub Copilot OAuth setup goes directly to the public device flow,
then renders the Agent-provided intersection of account-available and locally
known models. The terminal selection is kept open until an answer is received.
Selection and validation failures leave both the previous credential and Agent
default model unchanged. A later credential replacement does not prompt for a
model again.

### Session Semantics

- `run` creates a new Session unless `--session` or `--continue` is supplied.
- Without a configured default model, a new Session requires `--model`.
- `chat` delays new Session creation until the first message or a command that
  needs Session state. Entering `/exit` immediately leaves no empty Session.
- `--workspace`, `--model`, and `--thinking` configure a new Session.
- Resumed Sessions reject model/thinking creation overrides rather than
  silently changing or ignoring them. Interactive `/model` and `/thinking`
  are explicit durable Session updates.
- `/new` closes the currently loaded Session and makes the next message create
  a fresh Session.

## One-Shot Lifecycle

For `loopiq run`, the CLI:

1. validates command grammar and reads at most 1 MiB of prompt input;
2. constructs the Agent using the fixed per-user Agent Home;
3. creates or opens one Session;
4. subscribes before `Agent.run()` and buffers early envelopes until the
   returned Run identity is known;
5. emits `run_started`, streams mapped Agent events, waits for `RunResult`, and
   emits exactly one `run_completed` for every accepted Run under normal
   process control;
6. unsubscribes and calls `agent.shutdown({ abortRunning: true })` for setup,
   execution, and settlement paths after Agent construction.

The subscribe-before-run ordering prevents the CLI from losing early Session
events. `run` and each Chat message use the same small per-Run coordinator for
subscribe, start, wait, and unsubscribe. The callers retain their different
process lifetimes: one-shot mode shuts down after its result, while Chat keeps
one Agent until interactive exit. The CLI owns output mapping only; it does not
reinterpret the Agent turn loop.

## Versioned Machine Output

Every JSONL record uses:

```json
{"schema":"loopiq.cli.event","schemaVersion":1,"type":"..."}
```

The stream begins with `run_started`, maps internal envelopes to CLI-owned event
names, and ends with `run_completed`. Internal `run_settled` is not serialized,
so there is only one external terminal record.

The external event families are:

- Run start/completion;
- message start/delta/completion;
- tool start/progress/completion;
- context compaction;
- Provider response metadata with selected sensitive headers redacted;
- Session model/thinking changes, steering queue changes, save points, and
  lifecycle markers;
- `command_failed` for failures before a Run is accepted.

`run_completed` contains Session and Run identity, status, reason, Provider stop
reason, final assistant message, error, and aggregated assistant-message usage.
Current usage is labelled `partial` when available because context-compaction
inference is not included. It is labelled `unknown` when no Provider usage is
available. The CLI must not present either state as complete accounting.

JSON mode emits only the same complete `run_completed` object. Human text mode
streams assistant text and prints an explicit error for a failed, aborted, or
length-limited Run.

## Exit Codes

| Exit code | Meaning |
| --- | --- |
| `0` | Successful command or naturally completed Run |
| `1` | Run/setup/shutdown failure, including Provider length termination |
| `2` | CLI usage error |
| `3` | Top-level Provider or credential-store error |
| `4` | Session or Session-lock error |
| `130` | Observed Run interruption or aborted Run |

Machine output and stderr remain separated: JSON/JSONL command failures are
written to stdout as `command_failed`; interactive prompts and diagnostics use
stderr.

## Signal and Cleanup Semantics

One-shot and interactive modes handle `SIGINT` and `SIGTERM` after Agent
construction. An active Run is aborted through `Agent.abort()`. Interactive
`SIGINT` aborts the active Run and returns to the prompt; interactive `SIGTERM`
exits after settlement. Credential interactions receive an abort signal.

This is a graceful baseline, not a complete process supervisor. Signal handling
does not yet cover prompt stdin or Agent construction, repeated signals have no
bounded force-exit deadline, stdout can still block or fail independently, and
the Agent does not own background tool processes. Harbor therefore wraps the
CLI in its own process-group supervisor.

## Remaining Work

### P0 — Agent-Owned Run Limits

There is no total Run deadline, Provider-call limit, tool-call limit, token or
cost budget, or total output budget. Per-request Provider timeouts cannot bound
an unlimited multi-Turn Run. These limits belong in Agent execution policy and
must be surfaced in terminal reasons.

### P0 — Output, Event, and Memory Bounds

The CLI does not honor `stdout.write()` backpressure or provide controlled
EPIPE handling. Agent Session listeners are awaited serially, tool progress can
still retain substantial data, `RunResult.messages` retains all messages from
the Run, and Session open retains the complete JSONL store index. Fixing this
requires the event-delivery and output-bounding work in the roadmap, not only a
CLI `drain` call that would make a slow observer block core execution.

### P0 — Background Process Ownership

Background Bash work is not registered with or cleaned up by Agent shutdown.
The Harbor supervisor kills the entire evaluation process group as a containment
measure, including after a nominal CLI exit, but normal personal CLI use still
needs Session-owned background task management.

### P1 — Complete Run Semantics and Accounting

The CLI maps `stopReason: "length"` to failure, while the Agent's own
`RunResult.status` still treats it as completed. Aggregate usage excludes
context compaction and does not yet expose a complete Agent-owned accounting
contract. These semantics must move into Agent so every adapter agrees.

### P1 — Reproducibility and Recovery

`loopiq --version --format json` reports the CLI package version, optional build
revision, and event schema. Harbor currently installs a pinned source revision.
A published immutable artifact and lock/image digests are still needed for a
full release contract. A process crash restores committed Session history, not
an in-flight Provider request or tool execution.

## Verification Status

The CLI suite builds and spawns the real npm executable. It currently covers:

- strict argument grammar and option ownership;
- npm-bin/symlink startup, help, and machine-readable version output;
- ordered JSONL start/terminal output for an accepted failed Run;
- visible human-readable Run failures;
- lazy chat Session creation;
- real child-process terminal selection lifetime.

Still required are real signal timing tests, backpressure/EPIPE tests,
high-output memory tests, complete success fixtures with a deterministic fake
Provider boundary, clean-machine packaging tests, and container-level Harbor
success/failure/teardown fixtures.
