# Engineering Challenges and Current Responses

Status: Living document

Last reviewed: 2026-07-27

This document records difficult cross-cutting scenarios whose failure modes are
easy to miss when reviewing one subsystem in isolation. Each entry must separate
implemented behavior from proposed work. It is not a backlog substitute: when a
proposal is implemented, update the owning subsystem design document and this
record in the same change.

Each challenge should contain:

- the scenario and the invariant at risk;
- a concrete failure sequence;
- safeguards that exist in the current code;
- guarantees that the current code does not provide;
- the preferred direction, clearly marked when it is not implemented;
- verification required before the challenge can be considered resolved.

## EC-001: Concurrent File Mutation Across Sessions

Status: Open, partially mitigated

Affected subsystems: `AgentSessionManager`, `AgentSession`, built-in file
tools, and the Node execution environment.

### Scenario

One Agent process can load multiple Sessions concurrently. Different Sessions
are allowed to use the same `workspaceDir`, and each Session has its own
execution environment and tool instances. Two runs can therefore target the
same physical workspace file at the same time.

The required invariant is:

> A file mutation must not silently overwrite a change that occurred after the
> mutating operation's accepted input state was observed.

One active run per Session does not establish this invariant because runs in
different Sessions execute concurrently.

### Failure Sequence

The existing `Edit` and overwrite form of `Write` perform asynchronous file
operations. Without a shared mutation coordinator, two Sessions can interleave:

```text
Session A reads foo.ts at mtime 100
Session B reads foo.ts at mtime 100
Session A checks foo.ts at mtime 100 and is suspended
Session B checks foo.ts at mtime 100 and is suspended
Session A writes version A
Session B writes version B based on the old observation
```

Both checks were locally correct, but version B can silently replace version A.
This is a time-of-check/time-of-use race. A modification-time check alone does
not close the interval between validation and mutation.

The same workspace also admits conflicts outside the file tools: separate Bash
commands can edit files, run formatters, change Git state, or write shared build
outputs.

### Implemented Safeguards

The current implementation provides limited optimistic protection:

- `createDefaultTools()` creates one `FileAccessTracker` for a Session's Read,
  Write, and Edit tool instances.
- A successful Read records the absolute path and observed modification time.
- Editing or overwriting an existing file requires that Session's tracker to
  contain the current modification time.
- A successful Write or Edit records the resulting modification time, allowing
  a later mutation in the same loaded Session to proceed.
- New-file creation and append mode are intentionally exempt from the
  read-before-write check.
- A Session admits one active run, preventing two structural runs in the same
  Session from competing.

These safeguards commonly detect a file changed by another Session before the
later Session begins its mutation check. They do not make the check-and-write
sequence atomic.

The existing locks have different ownership and do not protect workspace files:

- `runtime.lock` protects one Session JSONL writer lease;
- `agent.lock` protects `agent.json` mutations;
- `credentials.lock` protects `credentials.json` mutations.

### Current Non-Guarantees

The current runtime does not provide:

- a process-wide per-file mutation queue shared by all Sessions;
- an atomic validate-and-write operation for Edit or overwrite Write;
- coordination with Bash or external processes that mutate the workspace;
- cross-process workspace locking when CLI and Server use the same `workspaceDir`;
- automatic Git worktree isolation for concurrently writing Sessions.

Consequently, sharing a `workspaceDir` is safe for independent or read-only
work, but it is not a guarantee of conflict-free concurrent mutation.

### Preferred Direction (Not Implemented)

Add an Agent-owned, process-wide file mutation coordinator and share it with the
file tools created for every Session.

The coordinator should:

1. Resolve a stable absolute key for the target file, using canonical paths for
   existing files so symlink aliases join the same queue.
2. Serialize the complete mutation window for one file: read current state,
   validate the accepted state, calculate the update, write it, and update
   tracking state.
3. Permit mutations of different files to proceed concurrently.
4. Hold ownership until an in-flight filesystem operation has actually settled,
   even when the run is aborted.
5. Remove idle queue entries so the coordinator does not grow without bound.

The coordinator must be created above `createDefaultTools()`. A queue created
inside each Session's tool set would reproduce the current isolation and would
not coordinate Sessions.

This process-local mechanism would cover built-in Edit and Write operations in
the shared Server process. It would not be presented as a security boundary or
as cross-process protection. Custom mutating tools would need to participate in
the same coordinator explicitly.

For intentionally parallel coding tasks, isolated working directories remain
the stronger boundary. A future worktree design should give each writing
Session or delegated Agent a separate checkout and define how changes are
reviewed, merged, retained, and cleaned up. Bash and external-process conflicts
cannot be comprehensively solved by wrapping only the built-in file tools.

### Verification Required

Before marking this challenge resolved, tests must demonstrate:

- two Sessions editing the same file cannot lose one update silently;
- an Edit that becomes stale while waiting either reapplies safely to the latest
  content or fails with a clear read-again/conflict result;
- Edit and overwrite Write participate in the same per-file queue;
- operations on different files can overlap;
- relative, absolute, normalized, and symlinked paths cannot bypass the queue;
- abort does not release a queue while an underlying write can still complete;
- queue entries are removed after success and failure;
- documented behavior for new-file creation, append, Bash mutation, and
  multiple Agent processes remains accurate.
