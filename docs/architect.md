# Architecture

This document is the canonical architecture reference for the LoopIQ Agent
monorepo. Keep it in sync with the code: whenever a change alters structure,
subsystems, public APIs, data flow, or inter-package dependencies, update the
relevant section here in the same change.

## Overview

LoopIQ Agent is a TypeScript monorepo (npm workspaces, `packages/*`) that
implements one Agent application with HTTP, CLI, and DevUI adapters:

- `@loopiq/ai` — externally sourced, read-only model/provider dependency.
- Agent (`packages/agent`, private workspace `@loopiq/agent`) — the application
  composition root plus turn loop, Session persistence, tools, and events.
- `@loopiq/server` (`packages/server`) — a Bun HTTP server (DevUI backend) that
  hosts multiple Sessions on one shared engine and exposes REST/SSE APIs.
- `@loopiq/devui` — a minimal web UI (static assets) for exercising the server.
- `@loopiq/cli` — standalone headless and interactive command-line adapter.

Dependency direction:

```
@loopiq/server --+
                 +-> Agent -> @loopiq/ai -> [LLM SDKs]
@loopiq/cli ----+
```

`@loopiq/devui` is framework-free static frontend served by `@loopiq/server`.

Build order: `ai`, then `agent`, then `cli`. The server runs directly
through Bun.

## Tooling & Configuration

- Package manager / workspaces: npm workspaces (`packages/*`), see `package.json`.
- Language: TypeScript 5.9, target ES2022, module Node16, strict mode
  (`tsconfig.base.json`); path aliases `@loopiq/ai` and `@loopiq/agent`
  (`tsconfig.json`).
- Lint/format: Biome 2.x (`biome.json`), 3-space indent, 120 col width.
- Scripts (root `package.json`): `build`, `test`, `check` (Biome), and `devui`
  (server).

## Package: `@loopiq/ai`

Purpose: provider-agnostic LLM API with model discovery and streaming.

- Main entry: `packages/ai/src/index.ts`.
- `src/api/` — per-provider API implementations (anthropic-messages,
  openai-responses, bedrock, google, mistral, azure, ...).
- `src/providers/` — provider configs across many clouds.
- `src/auth/` — credential store and OAuth flows.
- `src/utils/` — event streams, JSON parsing, retry, validation, diagnostics.
- Generated catalogs: `models.generated.ts`, `image-models.generated.ts`.

Key concepts: lazy-loaded model interface supporting streaming message exchange,
thinking levels (off → xhigh), and image models.

## Agent (`packages/agent`)

The private application runtime. It is not a published SDK or a collection of
independently assembled runtime pieces.

### Application entry (`src/agent.ts`)

`Agent` is the only application-level composition root:

- `src/agent.ts` — asynchronous composition root. It loads Agent settings,
  creates the internal model runtime and `NodeSessionHost`, installs built-in
  tools, and exposes Session/run, provider credential, model catalog, and
  configuration operations.
- `src/index.ts` — narrow adapter-facing barrel exporting `Agent`,
  `createAgent()`, errors, event envelopes, snapshots, and command/result types.
- `AgentEngine`, `AgentRunPort`, `AgentSession`, `NodeSessionHost`, persistence,
  environments, queues, and individual tool factories are internal subsystems.

The code-coupled multi-Session design is
[`techniquedocs/multi-session-runtime.md`](./techniquedocs/multi-session-runtime.md).
The implemented lifecycle contract is
[`techniquedocs/agent-runtime.md`](./techniquedocs/agent-runtime.md).
The newcomer-oriented execution walkthrough is
[`techniquedocs/agent-run.md`](./techniquedocs/agent-run.md).

Provider construction, credential persistence, model discovery, authentication,
and runtime model switching are documented in
[`techniquedocs/model-runtime-design.md`](./techniquedocs/model-runtime-design.md).

### Model runtime and Agent settings (`src/model/`, `src/node/`)

- `model/model-runtime.ts` — owns the `@loopiq/ai` `Models` collection, provider
  registration, model lookup, credential state, explicit credential
  add/validate/remove, OAuth refresh persistence, and a credential-bound online
  validation cache.
- `model/builtin-providers.ts` — the application-supported provider registry:
  GitHub Copilot, OpenAI Codex, OpenAI, Anthropic, Google, OpenRouter, DeepSeek,
  Moonshot AI CN, MiniMax CN, Z.AI Coding CN, and Kimi For Coding.
- `model/provider-types.ts` — serializable Agent-facing provider, model,
  credential-interaction, and configuration contracts. Adapter APIs never
  expose `@loopiq/ai` runtime objects.
- `node/node-agent-settings-store.ts` — atomic, locked `agent.json` persistence.
- `node/node-credential-store.ts` — atomic, owner-only, cross-process locked
  `credentials.json` persistence implementing the `@loopiq/ai` credential
  contract.
- `node/node-file-lock.ts` and `node/node-json-file.ts` — shared Node locking and
  atomic JSON primitives.

`createAgent({ dataDir })` is asynchronous because it initializes local durable
state. It performs no provider login, credential validation, token refresh, or
other network request.

### Engine and Session runtime (`src/engine/`, `src/runtime/`)

- `agent-engine.ts` — Session-stateless capability/factory capturing the shared
  model-runtime streaming capability.
- `agent-run.ts` — one short-lived mutable driver per accepted request. It owns
  provider/tool loop state and communicates only through `AgentRunPort`.
  Its complete flow, ordering guarantees, scenarios, and design rationale are
  documented in [`techniquedocs/agent-run.md`](./techniquedocs/agent-run.md).
- `agent-run-control.ts` — separates whole-run abort from provider-only
  inference interruption for interrupting steering.
- `agent-session.ts` — owns one Session's config, tools, queues, hooks,
  persistence, event sequence, and one-active-run lifecycle. Explicit
  `steer(runId, ...)` and `abort(runId)` reject stale run IDs.
- `event-envelope.ts` — adds `sessionId`, `runtimeId`, optional `runId`, sequence,
  and timestamp to outward notifications.
- `persisted-session-config.ts` — reserved runtime configuration entry contract.

### Runtime core (`src/core/`)

- `event-bus.ts` — awaited notification dispatch plus event-specific hook
  reducers for context, provider, before-agent, tool, and compaction hooks.
- `turn-state.ts` — per-provider-turn configuration snapshot.
- `tool-execution.ts` — sequential/parallel tool execution and lifecycle events.

### Message queues (`src/queue/`)

`message-queues.ts` — three-tier queueing owned by `AgentSession`: `steerQueue` (mid-turn injection),
`followUpQueue` (after current turn), `nextTurnQueue` (start of next turn). Drain
modes: `one-at-a-time` or `all`.

### Built-in tools (`src/tools/`)

Filesystem/shell tools implementing `AgentTool`, each created via a
`createXTool(env)` factory bound to an `ExecutionEnv` (so all IO flows through the
`Result`-based env abstraction, never throwing at the boundary). Read/Write/Edit
additionally accept an optional shared `FileAccessTracker` enforcing read-before-write.
Failures are surfaced by throwing inside `execute`, which `tool-execution.ts` wraps
into an error tool result.

- `read.ts` — `Read`, numbered-line file reads with `offset`/`limit`, a default
  line cap and a byte-size guard (large files require an explicit `offset`/`limit`),
  plus inline image support (png/jpg/gif/webp returned as base64 `ImageContent`).
- `write.ts` — `Write`, create/overwrite/`append` a file (reports `created`,
  `appended`, `bytesWritten`). When wired with a `FileAccessTracker`, overwriting
  an existing file requires it to have been read first.
- `edit.ts` — `Edit`, exact string replacement with unique-match guard and
  `replace_all`, plus a multi-edit `edits` array applied atomically in one write.
  Honors the same read-before-edit guard via the tracker.
- `bash.ts` — `Bash`, streamed shell execution via `executeShellWithCapture`
  (timeout, abort, output truncation spilling to disk), separated `STDERR:`
  section, optional `description`, and `run_in_background` (detached, streaming to
  a log file read back later).
- `grep.ts` — `Grep`, pure-Node recursive regex search (`content` /
  `files_with_matches` / `count` modes, basename glob filter, language `type`
  filter, `-A`/`-B`/`-C` context, `multiline` matching, `offset`, `head_limit`).
- `glob.ts` — `Glob`, pattern file matching (`**`, `*`, `?`, `{a,b}` brace
  expansion) sorted by mtime, with `max_depth` and `absolute` path output.
- `list-dir.ts` — `ListDir`, direct or recursive directory listing (directories
  marked with a trailing `/`).
- `index.ts` — tools barrel; `createDefaultTools(env)` returns the seven tools
  above as the default set, wiring a shared `FileAccessTracker` into Read/Write/Edit.
  Shared helpers live in `utils/` (`truncate.ts`, `shell-output.ts`,
  `file-access-tracker.ts`).

Each tool ships a co-located `*.test.ts`; `index.test.ts` covers the default-set
wiring with an end-to-end write/read/edit/search/list/exec round trip.

### Session persistence and Node hosting (`src/session/`, `src/node/`)

Append-only linear Session history persisted as JSONL. Physical JSONL order is
authoritative; the current format has no in-file branching or tree navigation.
See [`session.md`](./session.md) for the format,
invariants, evolution policy, and current limitations.

- `session.ts` — `Session`, high-level API over `SessionStorage`:
  `getEntries()`, `buildContext()`, `appendMessage()`, `appendCompaction()`,
  `appendCustomEntry()`, `appendCustomMessageEntry()`.
- `session-writer.ts` — `SessionWriter`, buffered writer batching pending entries
  and flushing them serially (`flush()`).
- `jsonl-storage.ts` — `JsonlSessionStorage`, linear JSONL backend. Header line =
  Session metadata (id, timestamp, cwd); each following line is a
  JSON line typed as `message` | `compaction` | `custom` | `custom_message`.
  Unsupported entry types, malformed entries, and duplicate IDs are rejected.
  Entry IDs use uuidv7.
- `storage-utils.ts` — storage error conversion plus the `SessionStorage` to
  `Session` adapter.
- `node-session-host.ts` — durable layout, discovery, single-flight open,
  create/list/close/delete/shutdown, config restore, and per-Session tools.
- `node-session-lease.ts` — exclusive `runtime.lock` writer lease preventing a
  second process from opening the same Session for writes.

The default layout is:

```text
<dataDir>/
  agent.json
  credentials.json
  sessions/<sessionId>/{session.jsonl,runtime.lock}
```

The lock directories used for Agent settings and credentials exist only during
mutations. Model, thinking, and active-tool selection are stored as the latest
`loopiq.session_config` custom entry and excluded from model context.

### Context compaction (`src/context/compaction/`)

`compaction.ts` contains context-window estimation and summary helpers. It is
not yet invoked automatically by `AgentRun`; loop integration remains planned.
The `session_before_compact` hook can override or augment explicit compaction.

### Base types (`src/base/`)

- `messages.ts` — `AgentMessage` union (LLM messages + custom types such as
  `BashExecutionMessage`, `CustomMessage`, `CompactionSummaryMessage`);
  extensible via module augmentation.
- `session-types.ts` — `SessionEntry`, `SessionStorage`, `SessionMetadata` /
  `JsonlSessionMetadata`, `PendingSessionWrite`.
- `resource.ts` — `AgentTool`, `Skill` (from SKILL.md), `PromptTemplate`,
  `AgentResources`.
- `options.ts` — `AgentStreamOptions`, `QueueMode`, `AgentSessionConfig`.
- `events.ts` — `AgentEventBus`; notification events (broadcast) vs hook events
  (interceptable, e.g. before_agent_start, context, before_provider_request,
  tool_call, tool_result, session_before_compact, model_update).
- `types.ts` — `Result<T,E>`, and `CompactionError` / `SessionError` /
  `AgentRuntimeError` variants.

## Package: `@loopiq/server`

`@loopiq/server` (`packages/server`) is the DevUI backend: a Bun HTTP adapter
that owns one `Agent` and exposes its Session/run identity methods through
REST/SSE. It depends on the Agent entry only and has no direct `@loopiq/ai`
dependency.

- `server.ts` — Bun HTTP server (port via `DEVUI_PORT`, default 4100).
  Session create/list/get/delete and explicit run/steer/abort routes use
  Session-scoped identities. SSE emits envelopes, disconnects backpressured
  clients, and redacts sensitive provider headers. `/api/runtime` exposes the
  model, configuration, and browser-selected Session ID used to bootstrap
  DevUI clients. Provider/model/configuration routes map directly to Agent
  operations.
- `runtime-factory.ts` — constructs the Agent and selects the browser Session;
  it does not construct providers or authentication storage.
- `provider-credential-jobs.ts` — adapter-only asynchronous job state that maps
  Agent credential prompts/events/cancellation/completion to HTTP/SSE. It never
  owns or persists credentials. Terminal events remain replayable for five
  minutes before the job and its listeners are discarded.

## Package: `@loopiq/cli`

`packages/cli` provides the `loopiq` executable. It calls only the `Agent`
entry, accepts an argument or stdin, and renders text, JSON, or JSONL with
deterministic exit codes. `chat` provides a sequential interactive mode.
`sessions list/create/delete` use the same durable layout. Authentication
prompts and diagnostics use stderr so machine-readable stdout stays clean.
Provider list/add/remove, model list, and Agent configuration commands call
Agent APIs; the CLI has no direct `@loopiq/ai` dependency.

## Package: `@loopiq/devui`

Private, framework-free frontend. `public/index.html` + `public/app.js` discover
the browser Session through `/api/runtime`, connect to its Session-scoped SSE
stream, and use explicit run/steer/abort routes. Chat bubbles are driven entirely
by envelope events, so prompts submitted by the browser or another client render
identically.

## Agent control tool: `devui-control`

A repo-local tool that lets another agent drive the running devui server the same
way a human uses the browser UI. It discovers and observes the same browser
Session, so its prompts also appear on the browser devui.

The executable entities live in a cross-agent, git-tracked location so any code
agent (Claude Code, Codex, etc.) can use them:

- `.github/agent-tools/devui-control/client.mjs` — dependency-free client: an
  async-generator over Session-scoped SSE plus runtime/session discovery and
  POST helpers.
- `.github/agent-tools/devui-control/devctl.mjs` — CLI with `send` (submit a
  prompt, block until its `run_settled`, print the assistant's final reply),
  `abort`, and `watch`. All actions carry explicit Session and run identities.
  Server URL is configured through `DEVUI_URL` / `DEVUI_PORT`.
- `.github/agent-tools/devui-control/README.md` — canonical usage doc.
  Limitations: the tool shares the browser-selected Session (sends can interleave
  with the human) and events are not replayed after disconnect.

Discovery entry points reference the tool without duplicating docs:

- `AGENTS.md` (repo root, cross-agent standard) has an `Agent Tooling` section;
  `CLAUDE.md` imports it via `@AGENTS.md`.
- `.agents/skills/devui-control/SKILL.md` is the canonical Codex auto-discovery
  manifest (frontmatter + pointer to the README).
- `.claude/skills/devui-control/SKILL.md` is a relative symlink to that canonical
  manifest, allowing Claude Code and Codex to share one skill definition.

## Data Flow

1. An adapter calls `Agent.run(sessionId, input)`. The Agent opens the internal
   Session and preflights its persisted credential, including durable OAuth
   refresh when required. An in-process provider-use guard excludes explicit
   credential mutation from preflight through run settlement.
2. The Session synchronously reserves a unique `runId` only after authentication
   preflight succeeds.
3. The internal `AgentSession` builds a turn snapshot and invokes the shared `AgentEngine`
   with a run-bound port and control channel.
4. A fresh `AgentRun` streams through `@loopiq/ai`, executes tools, and drains
   Session-owned queues at safe points.
5. Outputs and tool results pass through `AgentRunPort` into `Session` /
   `SessionWriter` and JSONL storage.
6. Compaction helpers can summarize old entries into a linear compaction entry;
   automatic triggering is not integrated yet.
7. `AgentSession` envelopes notifications with Session/run identity; the Agent
   routes subscriptions to Server and CLI adapters.

## Key Patterns

- Turn-based loop with mid-flight steering/follow-up queues.
- One shared Session-stateless engine with one active structural run per
  Session and concurrent runs across Sessions.
- Event-driven extensibility via interceptable hooks.
- Append-only, linear JSONL Session log.
- Lazy provider/model loading.
- Per-tool or global sequential/parallel tool execution.
- Context compaction primitives; automatic loop integration is still planned.
