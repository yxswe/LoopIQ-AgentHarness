---
name: devui-control
description: "Drive the running devui AgentHarness server like a human on the web UI. Use when you need to send a prompt to the devui agent, abort its current turn, or watch its live event/debug stream. Requires the devui server to be running (packages/server)."
---

# devui-control

Drive the running **devui** AgentHarness server from the command line, the same way
a human drives the browser devui (single shared session). Requires the devui server
to be running: start it from the repo root with `npm run devui`.

Full documentation lives at
[`.github/agent-tools/devui-control/README.md`](../../../.github/agent-tools/devui-control/README.md).

Key command:

```
node .github/agent-tools/devui-control/devctl.mjs <send|abort|watch> [args]
```
