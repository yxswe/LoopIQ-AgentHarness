---
name: code-review
description: Review code and architecture changes against this project's accumulated design rules. Use when reviewing a diff, pull request, public API, constructor dependency, ownership boundary, refactor, or implementation plan, and before implementing a change whose structure should be checked against prior design decisions.
---

# Code Review

Inspect real production call paths before judging an abstraction. Report concrete
findings with the affected code, violated rule, consequence, and smallest sound
correction. Do not invent findings merely to produce output.

## Review Process

1. Read the repository instructions and architecture documents required for the
   affected subsystem.
2. Trace every production caller and consumer of the changed abstraction.
3. Identify which object owns the behavior and which object owns any real choice.
4. Apply the design rules below and distinguish current requirements from
   hypothetical extension needs.
5. Lead with findings ordered by impact. Include file and line evidence, then a
   concise correction. State explicitly when no rule is violated.

## Design Rules

### Reject Speculative Injection Points

Do not add constructor options, callbacks, factories, registries, optional hooks,
or multi-layer parameter forwarding for hypothetical future customization.

Require an injected dependency to satisfy at least one condition:

- The caller owns a current, real policy choice.
- Multiple production implementations exist.
- The dependency isolates an external side effect or unstable boundary.

If one production implementation exists and the receiving object owns the
behavior, keep the implementation inside that object. Do not preserve a
production abstraction solely for test injection; introduce the narrowest test
seam at the actual unstable boundary instead.

During review:

- Find all production implementations and call sites.
- Flag parameters that intermediate objects only store, forward, or invoke
  unchanged.
- Ask what behavior disappears if the injection point is removed.
- Remove optionality when the application always requires the capability.
- Keep the abstraction only when its present owner and variation are explicit.
