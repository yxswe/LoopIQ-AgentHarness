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
  instantiates a harness via `createNodeHarness` and exposes it over SSE + REST.
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

### Public API surface (`src/index.ts`, `src/node.ts`)

Two barrels, matching the package's `.` and `./node` exports:

- `src/index.ts` — platform-agnostic barrel. Exports the `AgentHarness` class
  plus its outward-facing interfaces/types (options, resources, messages,
  events, public session types, error classes, `Result`). Internal
  implementation (TurnRunner, SessionWriter, MessageQueues, concrete
  storage/env classes) is intentionally not exported.
- `src/node.ts` — node barrel. Re-exports `./index.ts` and adds
  `createNodeHarness(options: NodeHarnessOptions)`, the node initialization
  entry point. It assembles the node-only `NodeExecutionEnv` and JSONL
  `Session` (open-or-create) internally so callers pass only `cwd`,
  `sessionPath`, and harness config (`models`, `model`, `systemPrompt`,
  `tools`, ...) and never touch `NodeExecutionEnv` / `JsonlSessionStorage` /
  `Session` directly.

The `AgentHarness` constructor is unchanged and still accepts a low-level
`env`/`session`; `createNodeHarness` is the assembly layer over it.

### Core loop (`src/core/`)

- `agent-harness.ts` — `AgentHarness`, the main orchestrator. Holds `session`,
  `model`, `tools`/`activeToolNames`, `thinkingLevel`, `streamOptions`, message
  `queues`, `events` bus, and `phase` (idle | turn | compaction | retry). Public
  API: `prompt()`, `skill()`, `promptFromTemplate()`, `steer()`, `followUp()`,
  `nextTurn()`, runtime setters, `abort()`, `waitForIdle()`, `subscribe()`,
  `on()`.
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
the `@loopiq/agent-core` public API (`@loopiq/agent-core/node`) and `@loopiq/ai`.

- `server.ts` — Bun HTTP server (port via `DEVUI_PORT`, default 4100).
  Builds one harness via `createDefaultHarness()`. Endpoints: `GET /api/events`
  (SSE broadcast of all harness notification events), `POST /api/prompt`
  (`{text}`, enqueues `prompt()`, 202), `POST /api/abort` (calls `abort()`),
  `GET /` (serves `packages/devui/public`; override via `DEVUI_STATIC_DIR`).
  Data dir defaults to `packages/server/.data`. CORS enabled.
- `harness-factory.ts` — `createDefaultHarness()`. Resolves a GitHub Copilot
  credential, builds `Models`, selects the requested model, then delegates
  env/session assembly to `createNodeHarness()` from `@loopiq/agent-core/node`.
- `copilot-auth.ts` — `ensureCopilotCredential()`: reuse `COPILOT_GITHUB_TOKEN`,
  a stored credential, or run the GitHub Copilot device-code login flow.
- `file-credential-store.ts` — `FileCredentialStore`, a single-process
  file-backed `CredentialStore` serializing whole-file writes through one chain.

## Package: `@loopiq/devui`

Private, framework-free frontend. `public/index.html` + `public/app.js` connect to
the `/api/events` SSE stream, submit prompts to `/api/prompt`, and render chat
bubbles plus an event trace for debugging.

## Data Flow

1. Caller invokes `harness.prompt(text)`.
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
