# devui-control

Control the **devui** agent runtime from the command line, the same way a human
drives the browser devui. This tool discovers the browser's Session and uses the
Session-scoped API, so
anything you send here also appears on the browser devui as a user message, and
you observe the exact same event/debug stream a human sees.

## Requires the devui server (hard dependency)

Every command here is just an HTTP/SSE client — it does **nothing** on its own. It
only works while the devui server (`@loopiq/server`) is running and reachable. If
the server is down, commands fail fast with a connection error and exit non-zero.

Start the server from the repo root:

```
npm run devui
```

Equivalent forms:

```
npm run server -w @loopiq/server
bun run packages/server/src/server.ts
```

Notes:

- **First run needs auth.** With no stored credential (`packages/server/.data`),
  startup runs the GitHub Copilot device-code login (interactive) or reuses
  `COPILOT_GITHUB_TOKEN`. This must succeed once before `send` can get a reply.
- **Wait until it's up.** The server prints `[devui] server on http://localhost:4100`
  when ready. Give it a moment after launch before running commands.
- **URL/port.** Defaults to `http://localhost:4100`. Override the server port with
  `DEVUI_PORT`, and point this tool at a different address with `DEVUI_URL` or
  `DEVUI_PORT` (both must match the running server).

## Commands

Run with `node` (Node 22+) or `bun`:

```
node .github/agent-tools/devui-control/devctl.mjs <command> [args]
```

### send — prompt and wait for the reply (blocking)

```
node .github/agent-tools/devui-control/devctl.mjs send "list the files in this repo"
```

Opens the Session event stream, submits the prompt, blocks until the run settles
(`run_settled`), then prints the assistant's final reply to stdout. The prompt and
the streamed reply also show up live on the browser devui.

### abort — stop the current turn

```
node .github/agent-tools/devui-control/devctl.mjs abort
```

Same effect as the devui Abort button.

### watch — stream the live event/debug feed

```
node .github/agent-tools/devui-control/devctl.mjs watch
```

Prints every event (message lifecycle, tool calls, provider requests, compaction,
etc.) as one line each until interrupted with Ctrl-C. This is the debug/trace view
the browser devui shows on the right. Useful to observe a turn started elsewhere.

## Notes and limitations

- **Shared browser Session.** The tool discovers the DevUI's `defaultSessionId`
  from `/api/runtime`; all run, steer, abort, and event calls then carry explicit
  Session and run IDs.
- **No history replay.** `watch` and `send` only see events from the moment they
  connect. Events emitted before connecting are not replayed.
- **Blocking send assumption.** `send` returns on the matching `run_settled`
  event. A send during an active run becomes explicit steering for that run.
