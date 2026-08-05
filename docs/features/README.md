# Feature Planning Notes

This directory contains implementation-readiness reviews and feature plans. It
does not replace the canonical system map in [`../architect.md`](../architect.md)
or the code-coupled subsystem documents under [`../techniquedocs`](../techniquedocs).

Documents distinguish the current implementation from proposed work. A planned
capability must not be treated as part of the public contract until the code,
tests, and architecture documentation have been updated together.

## Active Notes

- [`cli-headless-readiness.md`](cli-headless-readiness.md) — review of the CLI,
  unattended execution, long-running tasks, machine-readable output, and the
  work required before the CLI is a reliable evaluation boundary.
- [`harbor-local-evaluation.md`](harbor-local-evaluation.md) — proposed Harbor
  integration, trial ownership, adapter responsibilities, trace artifacts, and
  phased acceptance criteria.
