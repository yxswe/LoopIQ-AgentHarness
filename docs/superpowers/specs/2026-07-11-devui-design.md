# DevUI Design

Date: 2026-07-11
Status: Approved

## Goal

Provide a local developer UI (`devui`) to manually test an `AgentHarness`
instance. On process startup the server builds a single default harness
instance, authenticates with GitHub Copilot, and serves a browser UI that can
send prompts and observe the harness event trace in real time.

## Scope

- New private workspace package `packages/devui`.
- Only the devui process runs on Bun. The rest of the monorepo keeps npm /
  vitest / tsgo unchanged. The root `build` script is not modified.
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

```
packages/devui/
  package.json              # private package, scripts run via bun
  tsconfig.json             # extends repo base (optional, for editor typing)
  src/
    server.ts               # Bun HTTP entry; builds harness on startup
    harness-factory.ts      # assembles env / models / session / harness
    copilot-auth.ts         # ensure Copilot credential (device-code login)
    file-credential-store.ts# file-backed CredentialStore implementation
  public/
    index.html              # chat + event-trace UI, vanilla JS, no build step
  .data/                    # gitignored: credentials.json, session.jsonl
```

Root `package.json` gains a `devui` script that forwards to the package
(`bun run --cwd packages/devui src/server.ts` or a package-local `dev` script).
`packages/devui` is added to the existing `workspaces` glob (`packages/*`) so it
resolves `@loopiq/agent-core` and `@loopiq/ai`.

## Runtime: Bun

- `packages/devui/package.json` scripts use Bun directly, e.g.
  `"dev": "bun run src/server.ts"`. Bun runs TypeScript natively, so no tsx /
  tsgo build step is needed for devui.
- HTTP server uses `Bun.serve`.
- No change to other packages' toolchain.

## Startup Flow (`server.ts`)

Executed synchronously on process start, before serving:

1. Resolve a data directory `packages/devui/.data/` (created if missing).
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
   `JsonlSessionStorage.create(env.fs, ".data/session.jsonl")` (or `.open` if it
   already exists) and wrap it in `new Session(storage)`.
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
The file lives under `.data/` and is gitignored.

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

- `GET /` -> serve `public/index.html`.
- `GET /api/events` -> SSE stream. On connect, call `harness.subscribe(listener)`;
  for each harness event, write an SSE frame `data: <JSON.stringify(event)>\n\n`.
  Unsubscribe on connection close.
- `POST /api/prompt` -> body `{ text: string }`. Call `harness.prompt(text)`.
  Do not block the HTTP response on completion; return `202` immediately. The
  assistant output and all lifecycle events flow back over the SSE stream.
- `POST /api/abort` -> `harness.abort()`, return the abort result summary.

Single global harness; a single SSE subscriber is expected but multiple
connections are allowed (each gets its own subscription).

### public/index.html (frontend)

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
- `COPILOT_GITHUB_TOKEN` (optional) — bypass device login

## Testing / Verification

Manual verification (this is a dev tool):

1. `bun run` the devui; complete Copilot device login on first run.
2. Open the browser UI; send a prompt; confirm streaming assistant text.
3. Confirm the trace panel shows lifecycle events (before_agent_start,
   context, tool/text events, save_point, settled).
4. Restart the process; confirm no re-login is required (credential persisted)
   and the prior session transcript is loaded from `.data/session.jsonl`.

## Open Questions / To Confirm During Planning

- Exact `NodeExecutionEnv` constructor signature and the `FileSystem` subset it
  exposes vs. what `JsonlSessionStorage` requires (`readTextFile`,
  `readTextLines`, `writeFile`, `appendFile`).
- Whether `createModels()` auto-registers the `github-copilot` provider or if
  the default provider set must be passed explicitly.
- Precise shape of assistant/text streaming events to drive incremental chat
  rendering.
