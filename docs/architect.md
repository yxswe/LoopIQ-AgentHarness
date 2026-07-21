# Architecture

This document is the canonical architecture reference for the LoopIQ-AgentHarness
monorepo. Keep it in sync with the code: whenever a change alters structure,
subsystems, public APIs, data flow, or inter-package dependencies, update the
relevant section here in the same change.

## Overview

LoopIQ-AgentHarness is a TypeScript monorepo (npm workspaces, `packages/*`) that
implements a general-purpose AI agent runtime. It has five packages:

- `@loopiq/ai` — unified multi-provider LLM abstraction layer.
- `@loopiq/agent-core` (`packages/agent-harness`) — the agent runtime: turn loop,
  session persistence, context compaction, tools, events, and Node host adapters.
- `@loopiq/server` (`packages/server`) — a Bun HTTP server (DevUI backend) that
  hosts multiple Sessions on one shared engine and exposes REST/SSE APIs.
- `@loopiq/devui` — a minimal web UI (static assets) for exercising the server.
- `@loopiq/cli` — standalone headless and interactive command-line adapter.

Dependency direction:

```
@loopiq/server --+
                 +-> @loopiq/agent-core -> @loopiq/ai -> [LLM SDKs]
@loopiq/cli ----+
```

`@loopiq/devui` is framework-free static frontend served by `@loopiq/server`.

Build order: `ai`, then `agent-harness`, then `cli`. The server runs directly
through Bun.

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

- `src/index.ts` — exports the compatibility `AgentHarness`, `AgentEngine`,
  `AgentSession`, `SessionHost`, run control/outcome/port types, and event
  envelopes. It also exports `NodeSessionHost`, `NodeExecutionEnv`, and built-in tool
  factories (`createReadTool`, ... `createListDirTool`, and the aggregate
  `createDefaultTools`) so callers can construct the default tool set against an
  env. The raw `Session` and storage structs remain internal and
  intentionally not exported.

`AgentHarness` is Node-runtime-based by default. Construction goes through the
static async factory `AgentHarness.create(options)`: the caller passes only
`cwd`, `sessionPath`, and harness config (`models`, `model`, `systemPrompt`,
`tools`, ...); the factory assembles the node-only `NodeExecutionEnv` and JSONL
`Session` (open-or-create) internally. Tools are supplied by the caller and are
bound to their own `NodeExecutionEnv` (built from the same `cwd`); the harness
does not inject its internal env into tool factories. The constructor is private
(session assembly is asynchronous).

The code-coupled extraction specification is
[`techniquedocs/headless-multi-session-engine.md`](./techniquedocs/headless-multi-session-engine.md).

### Engine and Session runtime (`src/engine/`, `src/runtime/`)

- `agent-engine.ts` — Session-stateless capability/factory capturing the shared
  `Models` streaming dependency.
- `agent-run.ts` — one short-lived mutable driver per accepted request. It owns
  provider/tool loop state and communicates only through `AgentRunPort`.
- `agent-run-control.ts` — separates whole-run abort from provider-only
  inference interruption for interrupting steering.
- `agent-session.ts` — owns one Session's config, tools, queues, hooks,
  persistence, event sequence, and one-active-run lifecycle. Explicit
  `steer(runId, ...)` and `abort(runId)` reject stale run IDs.
- `event-envelope.ts` — adds `sessionId`, `runtimeId`, optional `runId`, sequence,
  and timestamp to outward notifications.
- `persisted-session-config.ts` — reserved runtime configuration entry contract.

### Compatibility core (`src/core/`)

- `agent-harness.ts` — backward-compatible one-Session facade over a private
  engine/session. It preserves phase-dependent `send()` and naked events.
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
authoritative; the current format has no parent pointers, active leaf, in-file
branching, or tree navigation. See [`session.md`](./session.md) for the format,
invariants, compatibility policy, and current limitations.

- `session.ts` — `Session`, high-level API over `SessionStorage`:
  `getEntries()`, `buildContext()`, `appendMessage()`, `appendCompaction()`,
  `appendCustomEntry()`, `appendCustomMessageEntry()`.
- `session-writer.ts` — `SessionWriter`, buffered writer batching pending entries
  and flushing them serially (`flush()`).
- `jsonl-storage.ts` — `JsonlSessionStorage`, version 4 JSONL backend. Header line =
  session metadata (id, version, timestamp, cwd); each following line is a
  JSON line typed as `message` | `compaction` | `custom` | `custom_message`.
  Unsupported versions, entry types, malformed entries, and duplicate IDs are
  rejected. Entry IDs use uuidv7.
- `storage-utils.ts` — storage error conversion plus the `SessionStorage` to
  `Session` adapter.
- `node-session-host.ts` — durable layout, discovery, single-flight open,
  create/list/close/delete/shutdown, config restore, and per-Session tools.
- `node-session-lease.ts` — exclusive `runtime.lock` writer lease preventing a
  second process from opening the same Session for writes.

The default layout is
`<dataDir>/sessions/<sessionId>/{session.jsonl,runtime.lock}`. Model, thinking,
and active-tool selection are stored as the latest
`loopiq.session_config.v1` custom entry and excluded from model context.

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
  `AgentHarnessResources`.
- `options.ts` — `AgentHarnessStreamOptions`, `QueueMode`, `AgentHarnessOptions`.
- `events.ts` — `AgentEventBus`; notification events (broadcast) vs hook events
  (interceptable, e.g. before_agent_start, context, before_provider_request,
  tool_call, tool_result, session_before_compact, model_update).
- `types.ts` — `Result<T,E>`, and `CompactionError` / `SessionError` /
  `AgentHarnessError` variants.

## Package: `@loopiq/server`

`@loopiq/server` (`packages/server`) is the DevUI backend: a Bun HTTP server that
owns one `NodeSessionHost` and serves multiple Sessions through one shared
engine. It depends only on the `@loopiq/agent-core` public API and `@loopiq/ai`.

- `server.ts` — Bun HTTP server (port via `DEVUI_PORT`, default 4100).
  Session create/list/get/delete and explicit run/steer/abort routes use
  Session-scoped identities. SSE emits envelopes, disconnects backpressured
  clients, and redacts sensitive provider headers. Legacy `/api/prompt`,
  `/api/abort`, and `/api/events` target one default Session for DevUI.
- `harness-factory.ts` — resolves GitHub Copilot auth/models and constructs the
  shared host. `createDefaultHarness()` remains for compatibility callers.
- `copilot-auth.ts` — `ensureCopilotCredential()`: reuse `COPILOT_GITHUB_TOKEN`,
  a stored credential, or run the GitHub Copilot device-code login flow.
- `file-credential-store.ts` — `FileCredentialStore`, a single-process
  file-backed `CredentialStore` serializing whole-file writes through one chain.

## Package: `@loopiq/cli`

`packages/cli` provides the `loopiq` executable. `run` accepts an argument or
stdin and renders text, JSON, or JSONL with deterministic exit codes. `chat`
provides a sequential interactive mode. `sessions list/create/delete` use the
same durable host layout. The current default runtime configures GitHub Copilot;
auth and diagnostics use stderr so machine-readable stdout stays clean.

## Package: `@loopiq/devui`

Private, framework-free frontend. `public/index.html` + `public/app.js` connect to
the `/api/events` SSE stream, submit prompts to `/api/prompt`, and render chat
bubbles plus an event trace for debugging. Chat bubbles (both user and assistant)
are driven entirely by the SSE event stream — user bubbles come from
`message_start` events with `role: "user"` rather than optimistic local inserts —
so prompts submitted by any client (the browser form or an external agent) render
identically.

## Agent control tool: `devui-control`

A repo-local tool that lets another agent drive the running devui server the same
way a human uses the browser UI, over the existing HTTP/SSE surface (zero server
changes). It drives and observes the _same_ single shared harness/session, so its
prompts also appear on the browser devui.

The executable entities live in a cross-agent, git-tracked location so any code
agent (Claude Code, Codex, etc.) can use them:

- `.github/agent-tools/devui-control/client.mjs` — dependency-free client: an
  async-generator `events()` over the `/api/events` SSE stream plus `post()`
  helpers.
- `.github/agent-tools/devui-control/devctl.mjs` — CLI with `send` (submit a
  prompt, block until `agent_end`, print the assistant's final reply), `abort`
  (POST `/api/abort`), and `watch` (stream the live event/debug feed). Server URL
  via `DEVUI_URL` / `DEVUI_PORT`.
- `.github/agent-tools/devui-control/README.md` — canonical usage doc.
  Limitations: single shared session (sends interleave with the human) and no
  history replay (only events after connect).

Discovery entry points reference the tool without duplicating docs:

- `AGENTS.md` (repo root, cross-agent standard) has an `Agent Tooling` section;
  `CLAUDE.md` imports it via `@AGENTS.md`.
- `.agents/skills/devui-control/SKILL.md` is the canonical Codex auto-discovery
  manifest (frontmatter + pointer to the README).
- `.claude/skills/devui-control/SKILL.md` is a relative symlink to that canonical
  manifest, allowing Claude Code and Codex to share one skill definition.

## Data Flow

1. An adapter resolves `sessionId` through `SessionHost` and calls
   `AgentSession.startRun()`, which synchronously reserves a unique `runId`.
2. `AgentSession` builds a turn snapshot and invokes the shared `AgentEngine`
   with a run-bound port and control channel.
3. A fresh `AgentRun` streams through `@loopiq/ai`, executes tools, and drains
   Session-owned queues at safe points.
4. Outputs and tool results pass through `AgentRunPort` into `Session` /
   `SessionWriter` and JSONL storage.
5. Compaction helpers can summarize old entries into a linear compaction entry;
   automatic triggering is not integrated yet.
6. `AgentSession` envelopes notifications with Session/run identity for server,
   CLI, and SDK consumers. `AgentHarness` strips envelopes for legacy callers.

## Key Patterns

- Turn-based loop with mid-flight steering/follow-up queues.
- One shared Session-stateless engine with one active structural run per
  Session and concurrent runs across Sessions.
- Event-driven extensibility via interceptable hooks.
- Append-only, versioned, linear JSONL Session log.
- Lazy provider/model loading.
- Per-tool or global sequential/parallel tool execution.
- Context compaction primitives; automatic loop integration is still planned.
