# Roadmap / TODO

Forward-looking work items to evolve `@loopiq/agent-core` from a solid runtime
kernel into a complete, production-grade agent harness. See `docs/architect.md`
for the current architecture.

## Cross-cutting requirements (apply to EVERY item below)

These are not separate tasks — they are mandatory dimensions of every item's
design and implementation:

- **Observability**: every subsystem must be inspectable at runtime. Emit
  structured events on the `AgentEventBus`, expose metrics/traces (tool
  latency, token usage, cost, retries, queue depth, session/engine state
  transitions), and make failures diagnosable. Design the observability surface
  *while* designing the feature, not after.
- **Tests**: every item ships with tests. Cover the happy path, edge cases,
  cancellation/abort, and failure modes. Kernel logic (turn loop, session,
  compaction, queues, tools) must have unit tests; cross-package behavior needs
  integration tests. No item is "done" without tests.

---

## 1. Complete the built-in tool set

**Why**: The kernel currently ships zero concrete tools (`src/tools/` only has
`utils/`), and the server wires `tools: []`. The agent can only chat — it cannot
read/write files or run commands. This is the highest-priority gap.

**Scope**:
- Implement a core tool suite on top of the existing `AgentTool` interface and
  `ExecutionEnv` abstraction: file read, write, edit, search (grep/glob),
  directory listing, shell/bash execution.
- Support streaming partial results via `AgentToolUpdateCallback`, honor
  `AbortSignal`, and use the per-tool `executionMode` (sequential/parallel).
- Reuse `tools/utils` (`shell-output`, `truncate`) for output shaping.
- Wire a default tool set into `harness-factory` so the DevUI agent can act.

**Observability**: tool lifecycle events already exist
(`tool_execution_start/update/end`); ensure each tool populates rich `details`
for logs/UI, and report per-tool latency and truncation.

**Tests**: unit-test each tool against `ExecutionEnv`, including permission
errors, aborts, large-output truncation, and parallel execution ordering.

## 2. Auto-trigger context management in the loop

**Why**: Compaction is implemented as a standalone module
(`context/compaction/compaction.ts` — `shouldCompact`, `estimateContextTokens`,
`findCutPoint`, `generateSummary`), but nothing in `core/` (`turn-runner.ts` /
`agent-harness.ts`) ever calls it. The `"compaction"` phase literal exists but is
never entered. So context management is dead code from the loop's perspective —
long sessions will overflow the context window. Wiring this is the second
priority, right after having tools that actually generate context.

**Scope**:
- Invoke the compaction check at the right point(s) in the turn loop (e.g.
  before/after a provider call once usage is known), entering the `"compaction"`
  phase when `shouldCompact` returns true.
- Run the existing `findCutPoint` + `generateSummary` pipeline, append the
  compaction entry via `Session.appendCompaction`, and continue the turn on the
  compacted context.
- Honor the `session_before_compact` hook so apps can override/augment.
- Handle edge cases: compaction failure, abort during compaction, no valid cut
  point, and back-to-back compactions.

**Observability**: emit compaction lifecycle events (already partly present:
`session_compact`) with before/after token counts, cut point, and summary size;
surface the phase transition on the bus so DevUI can show it.

**Tests**: threshold triggering in-loop, correct cut-point selection, summary
appended and context rebuilt, hook override respected, and abort-safety.

## 3. CLI & headless entrypoint

**Why**: The harness can only be driven by the DevUI server today. There is no
`bin`, so scripting/automation/CI use is impractical.

**Scope**:
- Add a CLI/headless entrypoint (a `bin` for the package or a dedicated CLI
  package) that constructs a harness, accepts a prompt (arg/stdin), streams
  output, and exits deterministically.
- Support one-shot and interactive modes, session selection/resume, model and
  thinking-level flags, and machine-readable output (JSON/JSONL) for piping.

**Observability**: structured (JSONL) event output mode so external tools can
consume the same event stream the DevUI sees; clear exit codes for failures.

**Tests**: end-to-end CLI tests (spawn process, feed prompt, assert output and
exit code), plus tests for flag parsing and headless session lifecycle.

## 4. Kernel test coverage

**Why**: Core runtime logic (turn loop, session, compaction, queues, skills)
currently has no unit tests — all existing tests live in `@loopiq/ai` and the
server's credential store. Correctness is unverified.

**Scope**:
- Turn loop: `TurnRunner`/`TurnState` — event ordering, tool execution
  (sequential/parallel), steer/follow-up/next-turn queue draining, abort.
- Session: append/branch/fork, `SessionWriter` buffering/flush atomicity,
  JSONL round-trip.
- Compaction: threshold triggering, first-kept marker, file read/write
  tracking, `session_before_compact` override.
- Queues and skills loading (SKILL.md discovery, frontmatter, ignore files).
- Introduce test fixtures / a fake `ExecutionEnv` and a faux model provider.

**Observability**: tests should assert on emitted events, making the event
contract itself part of the spec.

## 5. Stateless engine serving multiple sessions in parallel

**Why**: The harness currently binds one engine instance to one session. Goal:
extract session state so a single stateless agent engine instance can serve many
concurrent sessions in parallel. This is a foundational refactor — sub-agents
(item 6) can reuse the multi-session engine, so it lands first.

**Scope**:
- Separate the stateless "engine" (turn loop, tool dispatch, provider calls,
  compaction logic) from per-session state (messages, queues, session storage,
  phase, model/thinking selection).
- Thread session context explicitly through the engine instead of holding it as
  instance state; ensure concurrency safety (no shared mutable state across
  sessions).
- Update the server to route many sessions onto one engine; define session
  identity, lifecycle, and eviction.

**Observability**: per-session and per-engine metrics (active sessions,
throughput, queue depth, contention), and session-scoped tracing so concurrent
sessions remain distinguishable in logs/events.

**Tests**: concurrency tests (interleaved turns across sessions with no state
bleed), isolation/abort per session, and load/stress tests for the engine.

## 6. Sub-agent design

**Why**: No sub-agent / delegation mechanism exists (`subagent` grep = 0). Real
harnesses spawn isolated child agents for parallel or scoped tasks.

**Scope**:
- Design how a parent turn spawns a child agent (own context/session,
  restricted tool set, own budget), how results return to the parent, and how
  cancellation propagates.
- Decide isolation model: separate session branch vs separate engine instance
  (build on the stateless multi-session engine from item 5).
- Expose sub-agent invocation as a tool and/or a harness primitive.

**Observability**: parent↔child event correlation (trace/span IDs), aggregate
child token/cost/latency up to the parent, surface child lifecycle on the bus.

**Tests**: nested-agent execution, result propagation, abort propagation,
budget enforcement, and event correlation.

## 7. Hook optimization → plugin mechanism

**Why**: Today's hooks are internal, in-process interceptable events. There is
no external-command hook system and no plugin loading. Goal: a real plugin
mechanism compatible with the Claude Code and Codex plugin/marketplace formats.

**Scope**:
- Refine the internal hook system, then layer a plugin loader on top.
- Compatibility targets: load/run plugins authored for the **Claude Code** and
  **Codex** plugin marketplaces (skills, hooks/commands, tools) — map their
  manifests and lifecycle onto our hook/resource model.
- Define plugin discovery, sandboxing/permission boundaries, and versioning.
- Support external (shell/command) hooks analogous to Claude Code
  PreToolUse/PostToolUse in addition to in-process hooks.

**Observability**: log plugin load/resolve/failure, per-hook execution timing,
and which plugin handled each event; make plugin errors non-fatal and visible.

**Tests**: manifest parsing/compat for both marketplace formats, hook
ordering/short-circuit semantics, plugin failure isolation, and sandboxing.
