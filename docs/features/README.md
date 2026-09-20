# Feature Planning Notes

This directory contains implementation-readiness reviews and feature plans. It
does not replace the canonical system map in [`../architect.md`](../architect.md)
or the code-coupled subsystem documents under [`../techniquedocs`](../techniquedocs).

Documents distinguish the current implementation from proposed work. A planned
capability must not be treated as part of the public contract until the code,
tests, and architecture documentation have been updated together.

## Active Notes

- [`cli-headless-readiness.md`](cli-headless-readiness.md) — implemented CLI
  contract, machine-output protocol, long-running task gaps, and verification
  status.
- [`harbor-local-evaluation.md`](harbor-local-evaluation.md) — implemented
  import-path adapter/supervisor contract, trial lifecycle, artifacts, and
  phased local-evaluation plan.
