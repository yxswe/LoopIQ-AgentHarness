# DevUI Design

Date: 2026-07-11
Status: Approved

## Goal

Provide a local developer UI (`devui`) to manually test an `AgentHarness`
instance. A Bun-based backend server (in `packages/agent-harness/server/`)
builds a single default harness instance on startup, authenticates with GitHub
Copilot, and exposes an HTTP + SSE API. A separate frontend package
(`packages/devui`) provides the browser UI to send prompts and observe the
harness event trace in real time.

## Scope

- Front-end / back-end separation:
  - Back end lives in `packages/agent-harness/server/` — a standalone
    directory that will grow into the real backend server entry. It holds the
    HTTP server, harness factory, Copilot auth, and file credential store.
  - Front end is a new private workspace package `packages/devui` holding only
    static UI assets (HTML/JS). No backend logic.
- Only the backend server process runs on Bun. The rest of the monorepo keeps
  npm / vitest / tsgo unchanged. The root `build` script is not modified, and
  the `server/` directory is excluded from the library's tsgo build/dist so it
  does not pollute the `@loopiq/agent-core` published exports.
- Single harness instance, single session. No multi-session switching.
- The default instance ships with no tools. Tools are added later by the user.
- Session is persisted to disk via the existing `JsonlSessionStorage`.
- Transport is SSE (server to browser) + POST (browser to server).
- UI shows a chat panel plus a raw event trace panel.

## Non-Goals

- Multi-session / session tree navigation UI.
- Full observability dashboard (latency, failure rate, token analytics).
- Authentication providers other than GitHub Copilot.
- Any production hardening (auth on the HTTP endpoints, multi-user).

## Package Layout

Back end (in the existing `@loopiq/agent-core` package, but outside `src/`):

```
packages/agent-harness/
  server/                     # standalone backend, run by bun, NOT in tsgo dist
    server.ts                 # Bun HTTP entry; builds harness on startup
    harness-factory.ts        # assembles env / models / session / harness
    copilot-auth.ts           # ensure Copilot credential (device-code login)
    file-credential-store.ts  # file-backed CredentialStore implementation
    .data/                    # gitignored: credentials.json, session.jsonl
```

Front end (new package):

```
packages/devui/
  package.json                # private package, frontend only
  public/
    index.html                # chat + event-trace UI, vanilla JS, no build step
    app.js                    # (optional split) UI logic
```

The backend's `Bun.serve` serves both the API and the static frontend files
from `packages/devui/public` (resolved via a `DEVUI_STATIC_DIR`, default the
sibling devui package). This keeps the code separated by concern (frontend
authored in `packages/devui`, backend in `agent-harness/server`) while running a
single process for easy testing. CORS is enabled so the frontend can later be
hosted by its own dev server against the same API.

`packages/agent-harness/package.json` gains a `server` script:
`"server": "bun run server/server.ts"`. Root `package.json` gains a `devui`
script forwarding to it (`npm run server -w @loopiq/agent-core` or equivalent).
`packages/devui` is added to the existing `workspaces` glob (`packages/*`).
The `server/` directory and its `.data/` are excluded via `tsconfig.build.json`
and `.gitignore` respectively.

## Runtime: Bun

- The backend runs on Bun directly: `bun run server/server.ts`. Bun runs
  TypeScript natively, so no tsx / tsgo build step is needed for the server.
- HTTP server uses `Bun.serve`.
- No change to other packages' toolchain; agent-harness library still builds
  with tsgo (the `server/` dir is excluded from the build).

## Startup Flow (`server/server.ts`)

Executed synchronously on process start, before serving:

1. Resolve a data directory `packages/agent-harness/server/.data/` (created if
   missing).
2. Build `FileCredentialStore` backed by `.data/credentials.json`.
3. Ensure Copilot auth (`copilot-auth.ts`):
   - If `COPILOT_GITHUB_TOKEN` is set, rely on the provider's env-var api-key
     path; skip device login.
   - Else `store.read("github-copilot")`. If a credential exists, use it.
   - Else run `loginGitHubCopilot(...)`: print the user code and verification
     URL to the terminal, wait for the user to authorize in the browser, then
     persist the returned OAuth credential into the store via `store.modify`.
     After this, restarts skip login.
4. `createModels({ credentials: store })`. Confirm the `github-copilot`
   provider is registered (use the default provider set); look up the model via
   `models.getModel("github-copilot", modelId)` where `modelId` defaults to
   `claude-opus-4.6` and can be overridden with `DEVUI_MODEL`.
5. Build `NodeExecutionEnv` with `cwd` = repo root (or `DEVUI_CWD`). Create
   `JsonlSessionStorage.create(env.fs, "server/.data/session.jsonl")` (or `.open`
   if it already exists) and wrap it in `new Session(storage)`.
6. `new AgentHarness({ env, session, models, model, systemPrompt, tools: [] })`.
   `systemPrompt` is a simple default string.
7. Start `Bun.serve` on a configurable port (`DEVUI_PORT`, default e.g. 4100).

If Copilot login fails or times out, log the error to the terminal and exit
with a non-zero code so the user can retry.

## Components

### FileCredentialStore (`file-credential-store.ts`)

Implements the `CredentialStore` interface from `@loopiq/ai`:

- `read(providerId)` — read the credential from `credentials.json` (in-memory
  cache backed by the file), possibly expired.
- `modify(providerId, fn)` — serialized read-modify-write. Loads the current
  credential, calls `fn`, writes the result back to disk, returns the new
  credential. Serialization is per-provider (a simple in-process promise chain,
  matching `InMemoryCredentialStore`'s approach) so refresh/login writes do not
  race.
- `delete(providerId)` — remove the entry and rewrite the file.

Credentials are stored as the `Credential` union (`type: "oauth"` for Copilot).
The file lives under `server/.data/` and is gitignored.

### copilot-auth.ts

- `ensureCopilotCredential(store)`: implements the decision logic in startup
  step 3. Uses `loginGitHubCopilot` with terminal callbacks:
  - `onDeviceCode` -> print `userCode` + `verificationUri` + expiry.
  - `onPrompt` -> read a line from stdin (used for the optional enterprise
    domain prompt; blank = github.com).
  - `onProgress` -> print progress messages.
- On success, `store.modify("github-copilot", () => ({ ...credentials, type:
  "oauth" }))`.

### harness-factory.ts

- `createDefaultHarness()`: performs startup steps 4-6 and returns the
  `AgentHarness` instance plus references needed by the server (e.g. the model
  id for display).

### server.ts (Bun HTTP)

Routes:

- `GET /` (and other static paths) -> serve the frontend from
  `packages/devui/public` (`DEVUI_STATIC_DIR`).
- `GET /api/events` -> SSE stream. On connect, call `harness.subscribe(listener)`;
  for each harness event, write an SSE frame `data: <JSON.stringify(event)>\n\n`.
  Unsubscribe on connection close.
- `POST /api/prompt` -> body `{ text: string }`. Call `harness.prompt(text)`.
  Do not block the HTTP response on completion; return `202` immediately. The
  assistant output and all lifecycle events flow back over the SSE stream.
- `POST /api/abort` -> `harness.abort()`, return the abort result summary.

CORS headers are enabled on `/api/*` so the frontend can also be served from a
separate origin later. Single global harness; a single SSE subscriber is
expected but multiple connections are allowed (each gets its own subscription).

### packages/devui frontend (`public/index.html`)

Vanilla JS, no bundler:

- Opens an `EventSource("/api/events")`. `EventSource` auto-reconnects on drop.
- Left column — Chat: an input box that POSTs `{ text }` to `/api/prompt`.
  Renders user bubbles immediately; renders assistant bubbles by consuming
  assistant text/message events from the SSE stream (streaming as chunks
  arrive).
- Right column — Event trace: appends every SSE event in order as a list item
  showing `type` plus key fields (tool calls, token/usage, phase, save_point,
  etc.). Serves as the harness debugging view.
- Header: connection status indicator + an Abort button (POST `/api/abort`).

## Data Flow

```
browser input --POST /api/prompt--> server --harness.prompt()--> harness
harness --events--> harness.subscribe(listener) --SSE--> browser
  -> chat panel renders assistant text
  -> trace panel appends raw events
```

## Error Handling

- Copilot login failure/timeout: terminal error, process exits non-zero.
- Harness error/abort events: highlighted in the trace panel; chat shows an
  error bubble.
- SSE disconnects: `EventSource` reconnects automatically; the server drops the
  stale subscription on close.
- Invalid POST body: server returns `400`.

## Configuration (env vars)

- `DEVUI_PORT` (default 4100)
- `DEVUI_MODEL` (default `claude-opus-4.6`)
- `DEVUI_CWD` (default repo root) — harness `NodeExecutionEnv` working dir
- `DEVUI_STATIC_DIR` (default sibling `packages/devui/public`) — frontend assets
- `COPILOT_GITHUB_TOKEN` (optional) — bypass device login

## Testing / Verification

Manual verification (this is a dev tool):

1. `bun run server/server.ts` (or `npm run devui`); complete Copilot device
   login on first run.
2. Open the browser UI; send a prompt; confirm streaming assistant text.
3. Confirm the trace panel shows lifecycle events (before_agent_start,
   context, tool/text events, save_point, settled).
4. Restart the process; confirm no re-login is required (credential persisted)
   and the prior session transcript is loaded from `server/.data/session.jsonl`.

## Open Questions / To Confirm During Planning

- Exact `NodeExecutionEnv` constructor signature and the `FileSystem` subset it
  exposes vs. what `JsonlSessionStorage` requires (`readTextFile`,
  `readTextLines`, `writeFile`, `appendFile`).
- Whether `createModels()` auto-registers the `github-copilot` provider or if
  the default provider set must be passed explicitly.
- Precise shape of assistant/text streaming events to drive incremental chat
  rendering.
