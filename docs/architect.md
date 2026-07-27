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

### Application entry (`src/agent.ts`, `src/create-agent.ts`)

`Agent` is the only adapter-facing application surface, while construction is
kept separate from command execution:

- `src/agent.ts` — thin facade containing the public `Agent` contract and
  one-step delegation to Session, model, and configuration owners. It does not
  construct subsystems or coordinate multi-owner workflows.
- `src/create-agent.ts` — asynchronous composition root. It loads Agent
  settings, creates `ModelRuntime`, `AgentSettings`, `AgentEngine`, and
  `AgentSessionManager`, wires their narrow capabilities, and returns the
  facade. It contains construction only, not runtime command logic.
- `src/index.ts` — narrow adapter-facing barrel exporting `Agent`,
  `createAgent()`, errors, event envelopes, snapshots, and command/result types.
- `AgentEngine`, `AgentRunPort`, `AgentSession`, `AgentSessionManager`,
  persistence, environments, steering, and individual tool factories are
  internal subsystems.

The code-coupled multi-Session design is
[`techniquedocs/multi-session-runtime.md`](./techniquedocs/multi-session-runtime.md).
The implemented lifecycle contract is
[`techniquedocs/agent-runtime.md`](./techniquedocs/agent-runtime.md).
The newcomer-oriented execution walkthrough is
[`techniquedocs/agent-run.md`](./techniquedocs/agent-run.md).

Provider construction, credential persistence, model discovery, authentication,
and runtime model switching are documented in
[`techniquedocs/model-runtime-design.md`](./techniquedocs/model-runtime-design.md).

### Model runtime and Agent configuration (`src/model/`, `src/configuration/`)

- `model/model-runtime.ts` — owns the `@loopiq/ai` `Models` collection, provider
  registration, model lookup, switchable-model policy, credential state,
  same-Provider credential-mutation exclusion, explicit credential
  add/validate/remove, OAuth refresh persistence, and a credential-bound online
  validation cache.
- `model/builtin-providers.ts` — the application-supported provider registry:
  GitHub Copilot, OpenAI Codex, OpenAI, Anthropic, Google, OpenRouter, DeepSeek,
  Moonshot AI CN, MiniMax CN, Z.AI Coding CN, and Kimi For Coding.
- `model/provider-types.ts` — serializable Agent-facing provider, model, and
  credential-interaction contracts. Adapter APIs never expose `@loopiq/ai`
  runtime objects.
- `model/file-credential-store.ts` — atomic, owner-only, cross-process locked
  `credentials.json` persistence implementing the `@loopiq/ai` credential
  contract.
- `configuration/agent-configuration.ts` — public Agent configuration and update
  shapes.
- `configuration/agent-settings.ts` — owns the loaded configuration snapshot,
  update validation, persistence ordering, Session defaults, and Provider
  request-policy view.
- `configuration/file-agent-settings-store.ts` — atomic, locked `agent.json`
  persistence.
- `persistence/file-lock.ts` and `persistence/json-file.ts` — dependency-leaf
  filesystem primitives shared by feature-owned stores. They import no model,
  Session, credential, or configuration types.

`createAgent({ dataDir })` is asynchronous because it initializes local durable
state. It performs no provider login, credential validation, token refresh, or
other network request.

`agent.json` stores the Agent-wide default model, default thinking level, and
safe Provider request policy (`transport`, timeout, Provider retry count and
delay cap, and cache retention). The compiled defaults use thinking level
`high`, transport `auto`, a five-minute timeout, zero Provider retries, a
one-minute retry-delay cap, and short cache retention. Arbitrary request headers
and metadata are not part of the Agent configuration or runtime API.

### Engine and Session lifecycle (`src/engine/`, `src/session/`)

- `agent-engine.ts` — Session-stateless execution owner. It captures shared
  model lookup/streaming, System Prompt policy, Skills and Prompt Templates,
  the Session tool factory and duplicate-name validation, Provider request
  policy, and Turn snapshot construction. It creates one short-lived `AgentRun`
  per accepted request.
- `agent-run.ts` — one short-lived mutable driver per accepted request. It owns
  provider/tool loop state and communicates only through `AgentRunPort`.
  Its complete flow, ordering guarantees, scenarios, and design rationale are
  documented in [`techniquedocs/agent-run.md`](./techniquedocs/agent-run.md).
- `agent-run-control.ts` — separates whole-run abort from provider-only
  inference interruption for interrupting steering.
- `message-factory.ts` — creates normalized Run input and synthetic failure
  messages.
- `tool-execution.ts` — validates and executes tool batches in parallel,
  preserves assistant source order for tool-result messages, and emits
  lifecycle events.
- `turn-state.ts` — immutable per-provider-Turn snapshot plus conversion to the
  request-local model context.
- `session/agent-session.ts` — owns one loaded Session's incrementally maintained
  in-memory messages, config, tool instances, steering queue, persistence, event
  sequence, and one-active-run lifecycle. Explicit `steer(runId, ...)` and
  `abort(runId)` reject stale run IDs.
- `session/agent-session-manager.ts` — owns Session identity commands, durable
  discovery, loaded runtimes, single-flight open, model-switch application,
  environments, writer leases, and shutdown.
- `session/event-envelope.ts` — adds `sessionId`, `runtimeId`, optional `runId`, sequence,
  and timestamp to outward notifications.
- `session/session-contracts.ts` — adapter-facing Session snapshots, commands, handles,
  and results used by the Agent facade.
- `session/steering-queue.ts` — Session-owned steering storage. It drains one message
  at each safe point and restores a drained message if queue-update notification
  fails.

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

### Session storage (`src/session/storage/`)

Append-only linear Session history persisted as JSONL. Physical JSONL order is
authoritative; the current format has no in-file branching or tree navigation.
See [`session.md`](./session.md) for the format,
invariants, evolution policy, and current limitations.

- `session/storage/jsonl-session-store.ts` — the single persistence abstraction. It validates
  the header and entries, owns physical ordering, serializes appends, and
  restores model-visible messages plus the latest Session configuration once
  when a Session is loaded. Unsupported types, malformed entries, and duplicate
  IDs are rejected.
  Entry IDs use uuidv7.
- `session/storage/session-store-lease.ts` — exclusive `runtime.lock` writer lease
  preventing a second process from opening the same Session for writes.

The default layout is:

```text
<dataDir>/
  agent.json
  credentials.json
  sessions/<sessionId>/{session.jsonl,runtime.lock}
```

The lock directories used for Agent settings and credentials exist only during
mutations. Model and thinking level are stored in explicit `session_config`
entries and excluded from model context.

Opening a Session restores model-visible messages from validated JSONL entries
once. Successful message commits append to JSONL first and then update the
loaded `AgentSession` message array. A Run copies that history once when it
starts and then maintains its request-local context incrementally. Later Turn
refreshes do not copy the complete history or scan storage.

### Base types (`src/base/`)

- `messages.ts` — the `AgentMessage` alias for provider-compatible messages.
- `resource.ts` — `AgentTool`, `Skill` (from SKILL.md), `PromptTemplate`,
  `AgentResources`.
- `options.ts` — safe persisted `ProviderRequestPolicy`, trusted in-memory
  model/Session configuration, `AgentSystemPrompt`, and `ThinkingLevel`.
- `events.ts` — read-only Agent, Turn, message, tool, Provider-response, queue,
  and configuration notification contracts.
- `types.ts` — `Result<T,E>`, and `SessionError` / `AgentRuntimeError`
  variants.

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
Agent APIs. Configuration commands cover the default model, default thinking
level, and Provider request policy. The CLI has no direct `@loopiq/ai`
dependency.

## Package: `@loopiq/devui`

Private, framework-free frontend. `public/index.html` + `public/app.js` discover
the browser Session through `/api/runtime`, connect to its Session-scoped SSE
stream, and use explicit run/steer/abort routes. Chat bubbles are driven entirely
by envelope events, so prompts submitted by the browser or another client render
identically.

## Cross-cutting Engineering Challenges

Subtle scenarios that span multiple owners, together with implemented
safeguards, current gaps, and explicitly non-implemented directions, are tracked
in [`techniquedocs/engineering-challenges.md`](./techniquedocs/engineering-challenges.md).
The first maintained entry covers concurrent workspace-file mutation when
different Sessions share one `cwd`.

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

1. An adapter calls `Agent.run(sessionId, input)`. The thin facade delegates to
   `AgentSessionManager`, which opens the internal Session without validating,
   refreshing, or reserving its Provider credential.
2. The Session synchronously reserves a unique `runId` and returns a
   `RunHandle`. Actual request authentication is resolved by `@loopiq/ai` when
   the Provider request starts. Credential mutation is not coordinated with an
   active Run; a concurrent removal or replacement is observed naturally by
   whichever Provider request reads it.
3. The internal `AgentSession` copies its current in-memory messages once for
   the accepted Run. The shared `AgentEngine` combines mutable Session
   selection with its System Prompt, resources, tool policy, and current
   Agent-wide Provider request policy to create a Turn snapshot, then starts a
   run through a run-bound port and control channel.
4. A fresh `AgentRun` streams through `@loopiq/ai`, executes tools, and drains
   the Session-owned steering queue at safe points.
5. Complete outputs and tool results pass through `AgentRunPort` to
   `AgentSession`, which appends them to `JsonlSessionStore` and only then adds
   them to its in-memory message context.
6. `AgentSession` envelopes notifications with Session/run identity; the Agent
   routes subscriptions to Server and CLI adapters.

## Key Patterns

- Turn-based loop with mid-flight steering.
- One shared Session-stateless engine with one active structural run per
  Session and concurrent runs across Sessions.
- Append-only, linear JSONL Session log.
- Lazy provider/model loading.
- Parallel tool execution with source-ordered tool-result messages.
