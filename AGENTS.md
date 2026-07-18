# Architecture Documentation

- The canonical architecture reference lives at `docs/architect.md`.
- ALWAYS read `docs/architect.md` before making non-trivial code changes to
  understand the system structure.
- After ANY code change, ALWAYS check whether `docs/architect.md` needs updating
  (e.g. new/removed subsystems, changed public APIs, altered data flow or
  inter-package dependencies). If so, update it in the same change. Keep it in
  sync with the code.
- Subsystem design documents linked from `docs/architect.md` are code-coupled
  documentation, not optional background reading. Before changing a documented
  subsystem, read its linked design document. If the change affects behavior,
  data formats, invariants, compatibility, ownership, APIs, or known
  limitations, update that document in the same change with more detail than the
  architecture overview.
- `docs/architect.md` should remain the high-level map and link to the relevant
  detailed subsystem document instead of duplicating its full specification.

# Language Rules

- All conversational responses to the user MUST be written in Chinese.
- All code (including identifiers, variables, and function names) MUST be written in English.
- All code comments MUST be written in English.
- All documentation MUST be written in English.
- All pull request titles and descriptions MUST be written in English.
- All commit messages MUST be written in English.

# Agent Tooling

## devui-control

Drive the running devui AgentHarness server from the command line, the same way a
human drives the browser devui. It talks to the single shared session, so anything
you send also appears on the browser devui as a user message, and you observe the
exact same event/debug stream a human sees.

- **Hard dependency:** the devui server must be running. Start it from the repo
  root with `npm run devui` (package `packages/server`). Every command is just an
  HTTP/SSE client and does nothing on its own; if the server is down, commands
  fail fast with a connection error and exit non-zero.
- **Usage:** `node .github/agent-tools/devui-control/devctl.mjs <send|abort|watch> [args]`
  - `send "<prompt>"` — submit a prompt and block until the turn settles, then
    print the assistant's final reply.
  - `abort` — stop the current turn (same as the devui Abort button).
  - `watch` — stream the live event/debug feed until interrupted.
- **Full documentation:** see `.github/agent-tools/devui-control/README.md`.
