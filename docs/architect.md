# Architecture

This document is the canonical architecture reference for the LoopIQ-AgentHarness
monorepo. Keep it in sync with the code: whenever a change alters structure,
subsystems, public APIs, data flow, or inter-package dependencies, update the
relevant section here in the same change.

## Overview

LoopIQ-AgentHarness is a TypeScript monorepo (npm workspaces, `packages/*`) that
implements a general-purpose AI agent runtime. It has four packages:

- `@loopiq/ai` — unified multi-provider LLM abstraction layer.
- `@loopiq/agent-core` (`packages/agent-harness`) — the agent runtime: turn loop,
  session persistence, context compaction, tools, events. A pure library.
- `@loopiq/server` (`packages/server`) — a Bun HTTP server (DevUI backend) that
  instantiates a harness via `AgentHarness.create` and exposes it over SSE + REST.
- `@loopiq/devui` — a minimal web UI (static assets) for exercising the server.

Dependency direction:

```
@loopiq/server  ->  @loopiq/agent-core  ->  @loopiq/ai  ->  [LLM SDKs]
```

`@loopiq/devui` is framework-free static frontend served by `@loopiq/server`.

Build order: `ai` builds first (no internal deps), then `agent-harness`.

## Tooling & Configuration

- Package manager / workspaces: npm workspaces (`packages/*`), see `package.json`.
- Language: TypeScript 5.9, target ES2022, module Node16, strict mode
  (`tsconfig.base.json`); path aliases `@loopiq/ai` and `@loopiq/agent-core`
  (`tsconfig.json`).
- Lint/format: Biome 2.x (`biome.json`), 3-space indent, 120 col width.
- Scripts (root `package.json`): `build`, `test`, `check` (biome), `smoke`
  (example run), `devui` (server).

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

## Package: `@loopiq/agent-core` (packages/agent-harness)

The core runtime, published as a pure library. Subsystems below.

### Public API surface (`src/index.ts`)

A single barrel, matching the package's sole `.` export:

- `src/index.ts` — exports the `AgentHarness` class plus its outward-facing
  interfaces/types (options, resources, messages, events, `AbortResult`, error
  classes, `Result`). Also exports `NodeExecutionEnv` and the built-in tool
  factories (`createReadTool`, ... `createListDirTool`, and the aggregate
  `createDefaultTools`) so callers can construct the default tool set against an
  env. The `Session` / storage / session-tree structs are internal and
  intentionally not exported.

`AgentHarness` is Node-runtime-based by default. Construction goes through the
static async factory `AgentHarness.create(options)`: the caller passes only
`cwd`, `sessionPath`, and harness config (`models`, `model`, `systemPrompt`,
`tools`, ...); the factory assembles the node-only `NodeExecutionEnv` and JSONL
`Session` (open-or-create) internally. Tools are supplied by the caller and are
bound to their own `NodeExecutionEnv` (built from the same `cwd`); the harness
does not inject its internal env into tool factories. The constructor is private
(session assembly is asynchronous).

### Core loop (`src/core/`)

- `agent-harness.ts` — `AgentHarness`, the main orchestrator. Holds `session`,
  `model`, `tools`/`activeToolNames`, `thinkingLevel`, `streamOptions`, message
  `queues`, `events` bus, and `phase` (idle | turn | compaction | retry). Public
  API is deliberately minimal: `send()` (single input entry — routes by phase:
  idle → new turn, busy → steer the running turn), `getModel()`/`setModel()`,
  `getThinkingLevel()`/`setThinkingLevel()`, `abort()`, and — kept public only
  transitionally, slated to become private — `subscribe()`/`on()`. The turn
  primitives (`prompt`/`steer`/`followUp`/`nextTurn`), explicit resource
  invocation (`skill`/`promptFromTemplate`), and `waitForIdle`/`getResources`
  are private internals behind `send()`.
- `turn-runner.ts` — `TurnRunner`, a short-lived executor for a single turn.
  Drives: agent_start → turn_start → process messages → LLM call → tool
  execution → compaction (if needed). Drains steer/follow-up queues at defined
  points and emits granular events.
- `turn-state.ts` — `TurnState`, per-turn config snapshot (messages, resources,
  stream options, session id, system prompt, active tools, thinking level).
- `tool-execution.ts` — executes tool calls from assistant content, sequential
  or parallel; emits tool lifecycle events.

### Message queues (`src/queue/`)

`message-queues.ts` — three-tier queueing: `steerQueue` (mid-turn injection),
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


### Session & persistence (`src/session/`)

Append-only session tree persisted as JSONL, with branching and compaction.

- `session.ts` — `Session`, high-level API over `SessionStorage`:
  `getBranch()`, `buildContext()`, `appendMessage()`, `appendCompaction()`,
  `appendCustomEntry()`, `appendCustomMessageEntry()`.
- `session-writer.ts` — `SessionWriter`, buffered writer batching pending entries
  and flushing atomically (`flush()`).
- `jsonl-storage.ts` — `JsonlSessionStorage`, JSONL file backend. Header line =
  session metadata (id, version, timestamp, cwd, parentSession); each entry is a
  JSON line typed as `message` | `compaction` | `custom` | `custom_message`.
  Entry IDs via uuidv7.
- `jsonl-repo.ts` — `JsonlSessionRepo`, factory to create/open/fork sessions and
  branch at a specific entry.

### Context compaction (`src/context/compaction/`)

`compaction.ts` — automatic context-window management. When token usage exceeds a
threshold, old messages are summarized into a compaction entry marking the
first-kept entry. Tracks file read/write operations. The `session_before_compact`
hook lets apps override or augment compaction.

### Base types (`src/base/`)

- `messages.ts` — `AgentMessage` union (LLM messages + custom types such as
  `BashExecutionMessage`, `CustomMessage`, `CompactionSummaryMessage`);
  extensible via module augmentation.
- `session-types.ts` — `SessionTreeEntry`, `SessionStorage`, `SessionMetadata` /
  `JsonlSessionMetadata`, `SessionRepo`, `PendingSessionWrite`.
- `resource.ts` — `AgentTool`, `Skill` (from SKILL.md), `PromptTemplate`,
  `AgentHarnessResources`.
- `options.ts` — `AgentHarnessStreamOptions`, `QueueMode`, `AgentHarnessOptions`.
- `events.ts` — `AgentEventBus`; notification events (broadcast) vs hook events
  (interceptable, e.g. before_agent_start, context, before_provider_request,
  tool_call, tool_result, session_before_compact, model_update).
- `types.ts` — `Result<T,E>`, and `CompactionError` / `SessionError` /
  `AgentHarnessError` variants.

## Package: `@loopiq/server`

`@loopiq/server` (`packages/server`) is the DevUI backend: a Bun HTTP server that
owns a single harness instance and exposes it over SSE + REST. It depends only on
the `@loopiq/agent-core` public API and `@loopiq/ai`.

- `server.ts` — Bun HTTP server (port via `DEVUI_PORT`, default 4100).
  Builds one harness via `createDefaultHarness()`. Endpoints: `GET /api/events`
  (SSE broadcast of all harness notification events), `POST /api/prompt`
  (`{text}`, enqueues `send()`, 202), `POST /api/abort` (calls `abort()`),
  `GET /` (serves `packages/devui/public`; override via `DEVUI_STATIC_DIR`).
  Data dir defaults to `packages/server/.data`. CORS enabled.
- `harness-factory.ts` — `createDefaultHarness()`. Resolves a GitHub Copilot
  credential, builds `Models`, selects the requested model, then delegates
  env/session assembly to `AgentHarness.create()` from `@loopiq/agent-core`. Wires
  the default built-in tool set via `createDefaultTools(new NodeExecutionEnv(...))`.
- `copilot-auth.ts` — `ensureCopilotCredential()`: reuse `COPILOT_GITHUB_TOKEN`,
  a stored credential, or run the GitHub Copilot device-code login flow.
- `file-credential-store.ts` — `FileCredentialStore`, a single-process
  file-backed `CredentialStore` serializing whole-file writes through one chain.

## Package: `@loopiq/devui`

Private, framework-free frontend. `public/index.html` + `public/app.js` connect to
the `/api/events` SSE stream, submit prompts to `/api/prompt`, and render chat
bubbles plus an event trace for debugging. Chat bubbles (both user and assistant)
are driven entirely by the SSE event stream — user bubbles come from
`message_start` events with `role: "user"` rather than optimistic local inserts —
so prompts submitted by any client (the browser form or an external agent) render
identically.

## Agent control skill: `.claude/skills/devui-control`

A repo-local Claude Code skill that lets another agent drive the running devui
server the same way a human uses the browser UI, over the existing HTTP/SSE
surface (zero server changes). It drives and observes the *same* single shared
harness/session, so its prompts also appear on the browser devui.

- `client.mjs` — dependency-free client: an async-generator `events()` over the
  `/api/events` SSE stream plus `post()` helpers.
- `devctl.mjs` — CLI with `send` (submit a prompt, block until `agent_end`, print
  the assistant's final reply), `abort` (POST `/api/abort`), and `watch` (stream
  the live event/debug feed). Server URL via `DEVUI_URL` / `DEVUI_PORT`.
- `SKILL.md` — usage for the agent. Limitations: single shared session (sends
  interleave with the human) and no history replay (only events after connect).

## Data Flow

1. Caller invokes `harness.send(text)` (idle → starts a turn; busy → steers).
2. `AgentHarness` builds a `TurnState` and runs a `TurnRunner`.
3. `TurnRunner` calls the `@loopiq/ai` model, streams output, and executes tool
   calls; steer/follow-up queues are drained at defined points.
4. Outputs and tool results are appended through `Session` /  `SessionWriter` into
   JSONL storage.
5. If token usage is high, compaction summarizes old entries.
6. Throughout, the `AgentEventBus` emits notification and hook events; DevUI (or
   any subscriber) observes them via `subscribe()` / SSE.

## Key Patterns

- Turn-based loop with mid-flight steering/follow-up queues.
- Event-driven extensibility via interceptable hooks.
- Append-only JSONL session log with branching (forking).
- Lazy provider/model loading.
- Per-tool or global sequential/parallel tool execution.
- Automatic context compaction to manage token budgets.
