# Roadmap / TODO

Forward-looking work items for evolving the Agent into a complete,
production-grade application. See `docs/architect.md` for the current
architecture.

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

## 1. Expand the built-in tool platform

**Current baseline**: the kernel ships seven concrete tools (`Read`, `Write`,
`Edit`, `Bash`, `Grep`, `Glob`, and `ListDir`) through
`createDefaultTools(env)`. The Agent installs this default set, and every tool
has co-located unit tests. The remaining work is to add higher-level agent
capabilities and strengthen the shared execution platform rather than rebuild
the filesystem/shell baseline.

### P1: AskUser tool

**Why**: the model has no structured way to pause a turn, request missing input,
and resume after the application receives a user response. Guessing or ending
the turn is currently the only option when clarification is required.

**Scope**:
- Add an `AskUser` tool with a structured question and optional constrained
  choices while still allowing free-form responses.
- Define the full suspend/resume lifecycle: request identity, pending state,
  response delivery, abort behavior, timeout/disconnect behavior, and duplicate
  response rejection.
- Expose the request through the event/API layer so headless applications and
  DevUI can provide responses without coupling the core package to a UI.

**Observability**: emit request, response, cancellation, timeout, and resume
events correlated with the originating turn and tool call. Do not record hidden
reasoning or credentials in the question payload.

**Tests**: structured and free-form responses, abort while waiting, timeout or
client disconnect, duplicate/late responses, and headless/DevUI integration.

### P1: Web tools

**Why**: filesystem and shell tools cannot reliably satisfy research tasks or
retrieve current external documentation. Applications should not need to invent
incompatible web-search and page-fetch contracts.

**Scope**:
- Add `WebSearch` and `WebFetch` as separate tools so discovery and retrieval
  remain independently controllable.
- Keep search-provider and HTTP-client concerns behind injectable interfaces;
  the core tool contract must not require a single vendor.
- Define URL policy, redirect limits, SSRF/private-network protection, content
  type handling, response-size limits, text extraction, cancellation, timeout,
  and citation/source metadata.
- Make network access explicitly configurable so offline or restricted
  applications can omit the tools entirely.

**Observability**: report provider, normalized target URL, status, latency,
redirect count, bytes received, extraction/truncation, and policy rejection
without logging authorization headers or sensitive query parameters.

**Tests**: provider failures, redirect loops, SSRF attempts, oversized and
binary responses, malformed pages, abort/timeout, deterministic result shaping,
and disabled-network behavior.

### P1: Progress planning tools

**Why**: multi-step work has no structured progress surface. Plans currently
exist only as assistant text, so applications cannot render, validate, or resume
task progress consistently.

**Scope**:
- Add a plan/progress tool surface equivalent to `StartPlan` and `TodoWrite`,
  with stable item identity and explicit `pending`, `in_progress`, and
  `completed` states.
- Define whether plan state is persisted as dedicated linear Session entries or
  owned by an application-provided store; do not add branching semantics back
  into Session.
- Enforce replacement/update semantics, ordering, at-most-one active item where
  configured, and deterministic behavior when a turn is aborted.
- Expose snapshots and updates through the event layer for CLI and DevUI
  rendering.

**Observability**: emit plan creation, replacement, item transition, completion,
and rejection events with session/turn correlation.

**Tests**: state transitions, invalid plans, replacement and resume, abort
behavior, persistence round-trips when enabled, and event ordering.

### P2: Background task management

**Why**: `Bash` can start a background command and return an id/log path, but
the Agent does not retain task state. There is no supported way to list a
task, inspect status and exit code, incrementally read its log, cancel it, or
clean it up.

**Scope**:
- Introduce a session-scoped background task manager with stable task ids,
  lifecycle states, timestamps, exit information, bounded log storage, and
  cancellation.
- Add `ListTasks`, `ReadTaskLog`, and `CancelTask` tools; support byte offsets or
  tail reads so polling does not repeatedly return the entire log.
- Route `Bash` background execution through the manager instead of launching an
  untracked promise.
- Define process-tree termination, Agent shutdown cleanup, completed-task
  retention, session restart behavior, and platform differences.

**Observability**: emit task start, output progress, state transition, exit,
cancellation, cleanup, and log-truncation events.

**Tests**: successful/failing commands, concurrent tasks, incremental log reads,
cancellation and process-tree cleanup, Agent shutdown, retention limits, and
restart/recovery semantics.

### P2: Platform-level tool timeout

**Why**: individual tools may honor `AbortSignal`, but a custom tool that ignores
the signal or never settles can block the entire turn indefinitely.

**Scope**:
- Enforce a default timeout in the shared tool executor around every tool call,
  independent of tool-specific timeout parameters.
- Allow an application default and an optional per-tool override, including an
  explicit opt-out for intentionally long-lived integrations.
- Abort the tool signal when the deadline expires, classify deadline expiry
  separately from user cancellation, and ignore updates emitted after timeout.
- Define how timeout interacts with sequential/parallel batches and early
  termination.

**Observability**: include configured deadline, elapsed time, timeout source,
and final classification in tool lifecycle events.

**Tests**: cooperative and non-cooperative tools, timeout races, user abort vs
deadline expiry, parallel batches, late updates/results, and timer cleanup.

### P2: Unified tool-result budget

**Why**: built-in tools perform local truncation, but an application or plugin
tool can still return an arbitrarily large result and consume the model context.
Tool-specific limits also produce inconsistent behavior.

**Scope**:
- Add a shared byte/token budget when converting final tool results into model
  message history, covering text and image content.
- Preserve the complete raw result for application-controlled diagnostics or
  external storage while providing only a deterministic bounded representation
  to the model.
- Append a visible truncation marker and structured metadata containing the
  original size, retained size, and retrieval reference when one exists.
- Define per-call and per-batch limits and their interaction with existing
  Read/Bash/Grep truncation.

**Observability**: report raw and model-visible sizes, truncation reason, budget
source, and external-result reference without duplicating large payloads in
events.

**Tests**: boundary sizes, multibyte text, mixed text/image results, parallel
batches, pre-truncated built-in results, replay from Session, and unavailable raw
result storage.

### P2: Skill tool

**Why**: skill discovery, validation, and invocation formatting already exist,
but there is no default model-callable tool for selecting and loading a skill on
demand. Applications must manually embed skill behavior in their system prompt.

**Scope**:
- Add a `Skill` tool backed by `AgentResources.skills`, exposing only
  model-invocable skill names and descriptions in its schema or prompt surface.
- Resolve a selected skill to `formatSkillInvocation()` content while honoring
  `disableModelInvocation`, duplicate-name validation, and relative reference
  locations.
- Define unknown/disabled skill errors and whether additional user instructions
  can accompany invocation.
- Keep resources construction-time fixed; adding this tool must not implicitly
  introduce runtime resource mutation.

**Observability**: emit selected skill identity, source path/provenance when
available, resolution failure, and invocation size without logging the full
skill body by default.

**Tests**: successful invocation, unknown and disabled skills, duplicate names,
relative reference location, optional additional instructions, and resource
snapshot behavior across turns.

## 2. Dynamic system prompt and project instruction assembly

**Why**: The application currently supplies one fixed sentence as its default
system prompt. Although skill formatting and a system-prompt callback already
exist internally, the default Agent does not assemble its tools, tool usage
guidance, project instructions, skills, or Session environment into the prompt.
The model therefore receives much less operational context than the runtime
actually provides.

**Scope**:
- Replace the fixed default string with an Agent-owned `buildSystemPrompt()`
  pipeline whose inputs are explicit and testable: Session cwd, current date,
  Engine-created tools, Agent resources, project instruction files, and optional
  Agent-owned replacement/append sources.
- Add optional `promptSnippet` and `promptGuidelines` metadata to `AgentTool`.
  Include only Engine-provided tools, deduplicate normalized guidelines, and keep full
  parameter documentation in tool schemas instead of repeating it in the
  system prompt.
- Load project instructions from `AGENTS.md` (and deliberately supported
  aliases) from the Session cwd and its ancestors with deterministic
  outer-to-inner precedence. Preserve each source path and wrap file contents in
  explicit structured boundaries so adjacent instruction files cannot blur
  together.
- Append the existing model-visible Skills block only when an Engine-owned tool can
  retrieve the referenced skill file. Keep disabled skills out of the prompt and
  preserve absolute skill locations for relative-reference resolution.
- Add the current date in stable `YYYY-MM-DD` form and the normalized Session cwd
  near the end of the prompt. Do not include current time, random identifiers,
  or other values that unnecessarily invalidate provider prompt caches.
- Build the prompt while capturing the Run snapshot. Engine-owned tool or
  project-instruction changes made during an active Run affect the next Run,
  not a later Provider request inside the current Run.
- Keep ownership inside Agent. CLI and Server may expose Agent configuration or
  resource-management operations later, but they must not construct different
  base identities or independently concatenate prompt fragments.
- Define replacement-versus-append precedence before supporting custom prompt
  files. Even a replacement prompt must retain explicitly selected project
  instructions, Skills, date, and cwd unless the Agent configuration disables
  those sections deliberately.

**Observability**: emit a structured prompt-build summary containing included
section names, tool names, instruction source paths, skill names, and a prompt
digest/size. Do not emit full project instructions, skill bodies, or the final
prompt by default because they may contain sensitive local content.

**Tests**: deterministic assembly and section ordering, included/excluded tool
metadata, duplicate guideline removal, ancestor instruction precedence, XML
escaping and boundaries, disabled or unreadable Skills, custom replacement and
append precedence, cwd/date normalization, tool changes between Runs, and
stable cacheable output for identical inputs on the same day.

## 3. Freeze structural configuration for the whole Run

**Why**: `AgentRun` currently receives an initial `TurnState`, but calls
`createTurnSnapshot()` again after every internal Turn. One accepted user
request can therefore change model, thinking level, System Prompt, tools, or
Provider request policy between its model/tool iterations. This makes one Run
internally inconsistent and can invalidate tool schemas, model-bound reasoning
state, and Provider prompt-cache assumptions. The intended configuration
boundary is the whole Run; an internal Turn is only one model response and its
tool results.

**Scope**:
- Capture one immutable Run snapshot after the Session accepts a request and
  reuse it for every Provider request and tool iteration in that Run.
- Include the selected model and Provider, thinking level, assembled System
  Prompt, model-visible tools and schemas, resources, and Provider request
  policy in that snapshot.
- Remove the per-Turn `refreshSnapshot()` path and the snapshot-construction
  capability from `AgentRunPort`. Rename `TurnState` and related APIs to express
  Run scope instead of preserving a misleading lifecycle name.
- Keep request-local messages, tool results, steering input, cancellation, and
  retry/usage bookkeeping mutable and incrementally maintained inside the Run.
- Allow Session configuration mutations during an active Run to be persisted
  and reported, but apply them only when the next Run snapshot is captured.
- Do not snapshot credential or token material. Authentication remains a
  ModelRuntime/Provider concern and may resolve or refresh credentials at the
  actual request boundary without changing the Run's selected Provider/model.
- If MCP, project files, or another external resource must eventually refresh
  between Provider requests, introduce a separate, explicitly bounded request
  state. Do not reopen the entire structural Run configuration as a side effect.
- Update the AgentRun and architecture documentation so `Run`, internal `Turn`,
  Provider request, Run snapshot, and request-scoped dynamic state have one
  unambiguous meaning.

**Observability**: emit the Run snapshot identity or digest once at Run start,
and correlate every Provider request with it. Configuration-change events that
occur during a Run must make it clear that the new value is pending for the next
Run.

**Tests**: change model, thinking level, System Prompt inputs, tools, and
Provider request policy while a multi-Turn Run is active and prove that all
requests in that Run use the original snapshot while the next Run uses the new
configuration. Cover steering, tool continuation, abort, configuration
persistence failure, and explicitly dynamic request-state behavior.

## 4. Auto-trigger context management in the loop

**Why**: Context compaction is not implemented. The previous standalone helpers,
unused JSONL entry variants, and unobservable hook/event declarations were
removed because no runtime path could reach them. Long Sessions will eventually
overflow a Provider context window until one cohesive design is implemented.

**Scope**:
- Design the context threshold, cut-point, summary, persistence, and in-memory
  replacement rules together rather than restoring the deleted detached
  helpers.
- Invoke compaction at an explicit Run save boundary once usage is known.
- Define one current JSONL entry shape only when the runtime can both write and
  restore it.
- Add hook and notification contracts only when Agent exposes a registration
  path and AgentRun actually emits them.
- Handle edge cases: compaction failure, abort during compaction, no valid cut
  point, and back-to-back compactions.

**Observability**: emit a defined compaction lifecycle with before/after token
counts, cut point, and summary size; surface the transition so DevUI can show
it.

**Tests**: threshold triggering in-loop, correct cut-point selection, summary
appended and context rebuilt, hook override respected, and abort-safety.

## 5. CLI & headless entrypoint

**Why**: The Agent needs consistent behavior across DevUI and headless use, with
reliable scripting, automation, and CI behavior.

**Scope**:
- Extend the CLI/headless entrypoint so it constructs the Agent, accepts a
  prompt (arg/stdin), streams
  output, and exits deterministically.
- Support one-shot and interactive modes, session selection/resume, model and
  thinking-level flags, and machine-readable output (JSON/JSONL) for piping.

**Observability**: structured (JSONL) event output mode so external tools can
consume the same event stream the DevUI sees; clear exit codes for failures.

**Tests**: end-to-end CLI tests (spawn process, feed prompt, assert output and
exit code), plus tests for flag parsing and headless session lifecycle.

## 6. Kernel test coverage

**Why**: the built-in tools and JSONL Session storage now have unit tests, but
the central turn lifecycle, queueing, compaction integration, event contracts,
and skill loading remain largely uncovered. These paths coordinate mutable
state and cancellation, so regressions can cross subsystem boundaries even when
individual tools and storage primitives pass.

**Scope**:
- Turn loop: `AgentRun`/`TurnState` — event ordering, tool execution
  (sequential/parallel), steering drain, and abort.
- Session: linear append/context semantics, incremental in-memory context,
  pending configuration flush ordering, storage failures, and concurrent append
  behavior. JSONL format validation and round-trips already have baseline
  coverage.
- Compaction: threshold triggering, cut-point semantics, summary persistence,
  and in-memory context replacement after the feature is designed.
- Queues and skills loading (SKILL.md discovery, frontmatter, ignore files).
- Introduce shared test fixtures, a fake `ExecutionEnv`, and a faux model
  provider for deterministic cross-subsystem tests.

**Observability**: tests should assert on emitted events, making the event
contract itself part of the spec.

## 7. Stateless engine serving multiple sessions in parallel

**Why**: The Agent must preserve isolation while sharing one engine across
Sessions. The stateless engine and explicit Session state form the foundation
for sub-agents in item 8.

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

## 8. Sub-agent design

**Why**: No sub-agent / delegation mechanism exists (`subagent` grep = 0). Real
Agents spawn isolated child Agents for parallel or scoped tasks.

**Scope**:
- Design how a parent turn spawns a child agent (own context/session,
  restricted tool set, own budget), how results return to the parent, and how
  cancellation propagates.
- Decide isolation model: separate session branch vs separate engine instance
  (build on the stateless multi-session engine from item 7).
- Expose sub-agent invocation as a tool and/or an Agent primitive.

**Observability**: parent↔child event correlation (trace/span IDs), aggregate
child token/cost/latency up to the parent, surface child lifecycle on the bus.

**Tests**: nested-agent execution, result propagation, abort propagation,
budget enforcement, and event correlation.

## 9. Hook optimization → plugin mechanism

**Why**: The runtime deliberately has no hook registration surface or plugin
loading. Goal: a real plugin
mechanism compatible with the Claude Code and Codex plugin/marketplace formats.

**Scope**:
- Design the plugin loader and its hook contracts together; do not add dormant
  hook events before a real registration path exists.
- Compatibility targets: load/run plugins authored for the **Claude Code** and
  **Codex** plugin marketplaces (skills, hooks/commands, tools) — map their
  manifests and lifecycle onto our hook/resource model.
- Define plugin discovery, sandboxing/permission boundaries, and versioning.
- Define both in-process and external (shell/command) hooks, including semantics
  analogous to Claude Code PreToolUse/PostToolUse.

**Observability**: log plugin load/resolve/failure, per-hook execution timing,
and which plugin handled each event; make plugin errors non-fatal and visible.

**Tests**: manifest parsing/compat for both marketplace formats, hook
ordering/short-circuit semantics, plugin failure isolation, and sandboxing.
