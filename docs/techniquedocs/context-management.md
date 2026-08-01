# Context Management Design

Status: Implemented behavior

Last audited: 2026-08-01

This document defines the implemented context-management contract.

## Ownership

Context management is an Agent business capability under
`packages/agent/src/context/`:

- the Session-owned context state contains the committed model-visible history;
- the context manager owns usage estimation, compaction planning, summary
  generation, and replacement construction;
- `AgentRun` invokes the context manager at the provider-request boundary;
- `JsonlSessionStore` persists and restores compaction checkpoints.

`AgentEngine` remains Session-stateless. It shares one stateless
`ContextManager`, but it does not hold a current Session history or compaction
state.

## Trigger

In this project, one Turn contains exactly one normal LLM call. Context checking
therefore happens exactly once per Turn, immediately before that call:

```text
start Turn
  -> include the user/steering input or previous tool results
  -> check context budget
  -> await compaction when required
  -> call the normal LLM
```

The check sees every message that would be sent by the imminent request. A tool
continuation therefore includes the preceding assistant tool call and its tool
results; the first Turn of a Run includes the new user input; a steering Turn
includes the drained steering message.

Compaction is awaited. It pauses the logical AgentRun until summary generation,
persistence, and in-memory replacement complete, while leaving the JavaScript
event loop available. It must never run in the background beside a normal model
request.

There is no separate post-response check. If a response or tool result crosses
the threshold, the next Turn detects it before making another LLM call. If no
next Turn exists, the next Run performs the check before its first call.

## Budget Detection

The active Turn model supplies the capacity through `model.contextWindow`. This
is the model catalog's declared effective limit, not a Provider guarantee that
is rediscovered on every request; Provider responses normally report usage, not
their maximum context capacity.

Current usage is calculated as follows:

1. Prefer the most recent successful assistant usage produced by the same
   Provider and model after the latest compaction.
2. Add deterministic estimates for messages appended after that response.
3. When compatible Provider usage is unavailable, estimate the complete
   model-visible context, including the System Prompt, tool schemas, text,
   images, and messages.

Compaction triggers when estimated usage is at least 90% of
`model.contextWindow`. The replacement aims for at most 50% so normal generation
and subsequent tool results have substantial headroom. The 50% value is a
target, not permission to remove the protected current-Turn suffix.

## Compaction Strategy

The 50% target is converted into a recent-original-text budget:

```text
target tokens = model.contextWindow * 0.50
recent text budget = target tokens
  - System Prompt and tool-schema estimate
  - reserved summary output
```

The context manager preserves as much recent original text as possible instead
of retaining a fixed number of messages. Its cut-point algorithm is:

1. Mark the minimum protected suffix. A user or steering message that has not
   yet been consumed by a normal LLM call must remain verbatim. For a tool
   continuation, the latest assistant tool-call message and all corresponding
   results must remain together.
2. Estimate each message and scan from newest to oldest, maintaining the token
   cost of the retained suffix.
3. Consider only legal cut points that do not enter the protected suffix.
4. Choose the oldest legal point whose fixed request prefix, reserved summary,
   and retained suffix still fit the 50% target. Choosing the oldest qualifying
   point maximizes retained original text.

The valid cut points are:

- before a `user` message, which preserves a complete instruction span;
- before an `assistant` message when one instruction span is itself too large.

A cut point is never placed before a `toolResult`. An assistant tool-call
message and its contiguous results therefore remain on the same side of the
cut. Compaction does not impose a global tool-call/result completeness rule.
Incomplete history can legitimately result from interruption, and Provider
message transformation normalizes it before a normal model request.

In this document, an instruction span begins with a user or steering message
and ends before the next such message. It is not an Agent Turn: a Turn in this
project contains exactly one normal LLM call, while one instruction span can
contain several assistant/tool Turns.

The normal case cuts before a user message:

```text
old complete spans | recent complete spans
       summarize   | retain verbatim
```

If the recent budget falls inside one unusually large, already-consumed
instruction span, the cut may move to an assistant boundary:

```text
older history | instruction-span prefix | recent assistant/tool suffix
 summarize     | summarize as bridge     | retain verbatim
```

The bridge summary uses a dedicated `Retained Suffix Bridge` section containing
the original request, early progress, state at the cut point, and context needed
to understand the retained suffix. It is emitted only when an instruction span
is split. This permits compaction during a long tool-using Run without retaining
the entire Run or leaving raw tool results detached from their call.

The context manager sends only compactable messages to the active model with a
dedicated handoff-summary prompt, no tools, and a maximum combined summary
output of 4,096 tokens. Tool results are deterministically truncated in the
summary request so a single large result cannot consume the summarization
budget. The normal Provider context remains unchanged until compaction commits.
The summary request does not enable model reasoning, so reasoning tokens cannot
expand the configured summary-output cap.

The summary System Prompt treats `conversation`, `previous-summary`, and
`instruction-prefix` as untrusted source data and forbids following
instructions found inside them. Credentials, passwords, API keys, tokens,
cookies, private keys, authorization headers, and other secrets must never be
copied into the durable summary; secret values are replaced with `[REDACTED]`.
Exact preservation applies only to non-secret paths, identifiers, commands, and
other continuation-critical facts.

For the first compaction, the summary is generated from the old raw prefix. For
later compactions, the previous summary is supplied separately with an update
instruction and only newly compacted raw messages are summarized. It is not
treated as ordinary conversation text. This reduces repeated information loss
and keeps back-to-back compaction requests bounded. An update produces one
replacement state checkpoint: it merges duplicate facts, moves explicitly
completed work to Done, removes explicitly resolved blockers, replaces outdated
next steps, and gives new explicit evidence priority over conflicting older
summary text. Unresolved new conflicts are preserved rather than guessed away.
The result describes current state instead of a chronological narrative and
does not copy long source code or tool output.

The normal state checkpoint and the optional Retained Suffix Bridge are
generated together by this single summary request. Compaction never makes a
second model request for the bridge.

The request uses the Run's Provider request policy and whole-run abort signal.
Steering remains queued and does not interrupt context maintenance.

The replacement is:

```text
summary user message
protected recent suffix
```

The summary uses an explicit context-summary marker and preserves goals,
decisions, constraints, completed work, relevant state, and remaining work. It
must not invent missing facts.

A result is installed only when it reduces usage and leaves the next normal
request below the 90% trigger. If no non-empty prefix is safe to remove, or the
System Prompt, tools, and protected suffix already consume the available
budget, the context is uncompactable and the normal model call does not start.

## Persistence and In-Memory Replacement

The JSONL log contains one current entry shape:

```ts
type ContextCompactionEntry = {
  type: "context_compaction";
  id: string;
  timestamp: string;
  compactedMessageCount: number;
  summary: UserMessage;
};
```

`compactedMessageCount` is the number of messages removed from the start of the
active model-visible history at that point in the log. The retained suffix is
not duplicated in the checkpoint.

Installation order is strict:

```text
append context_compaction to JSONL
  -> replace the loaded Session context
  -> replace AgentRun's request-local context
  -> emit compaction completion
```

Both in-memory histories apply the same operation:

```ts
messages = [summary, ...messages.slice(compactedMessageCount)];
```

Restoration replays entries in physical order. A `message` entry appends one
message; a `context_compaction` entry applies the replacement operation above.
The raw older entries remain in the append-only file but are no longer
model-visible. Persisting before memory replacement means a process crash can
be recovered by replay without exposing an unpersisted context state.

## Failure and Observability

Compaction emits `context_compaction_started`,
`context_compaction_completed`, and `context_compaction_failed` notifications
correlated with the Session and Run. They report the model, capacity, trigger,
before/after usage, compacted message count, retained message count, and summary
size, but not the summary body.

Summary failure, invalid output, an unsafe cut point, or persistence failure
installs no replacement and prevents the normal LLM call. Existing Run failure
reporting may then append its synthetic failure message to the unchanged
history. Whole-run abort cancels summary generation and installs no checkpoint.
