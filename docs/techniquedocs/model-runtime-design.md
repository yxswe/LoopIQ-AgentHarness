# Agent Model Runtime and Authentication Design

Status: Implemented behavior

Last reviewed: 2026-07-27

This document defines the implemented ownership and persistence boundaries between
the Agent, LLM providers, credentials, Sessions, the Server, and the CLI. It is
kept as a decision record so the reasons behind each boundary remain explicit.

## Goals

- Make `Agent` the single application composition root.
- Keep provider construction and credential persistence out of CLI and Server
  adapters.
- Create an Agent without requiring login, network access, or terminal input.
- Reuse persisted credentials across Agent process lifetimes.
- Register the agreed provider set on every Agent launch, independently of
  whether credentials have been supplied.
- Permit runtime credential addition, replacement, validation, and removal.
- Permit a Session to switch only to a provider whose persisted credential has
  been verified as usable.
- Keep the selected model for a Session durable and independent from the global
  default model.
- Give CLI and Server the same provider, authentication, and model behavior.
- Preserve `@loopiq/ai` as an externally sourced, read-only dependency.
- Remove the current duplicated credential stores and provider setup without
  retaining forwarding wrappers.

## Non-goals

- This change does not redesign the provider implementations in `@loopiq/ai`.
- This change does not introduce user-defined providers or a general provider
  plugin format.
- This change does not register every provider exported by `@loopiq/ai`; it
  registers the explicit application-supported set below.
- This change does not put credentials in Session JSONL.
- This change does not make Server or CLI own provider-specific behavior.
- This change does not make one Agent object represent one Session.
- This change uses one current persisted shape only. The project is still in
  development, so replaced code and parsers are removed directly.

## Previous State (Removed)

The replaced construction path was duplicated:

```text
CLI                                  Server
 |                                      |
 +-> FileCredentialStore                +-> FileCredentialStore
 +-> GitHub Copilot login               +-> GitHub Copilot login
 +-> createModels()                     +-> createModels()
 +-> register provider                  +-> register provider
 +-> resolve model                      +-> resolve model
 +-> createAgent({ models, ... })        +-> createAgent({ models, ... })
```

This created four problems:

1. `AgentOptions.models` exposes an internal runtime dependency and allows each
   adapter to assemble a different Agent.
2. CLI and Server duplicate provider-specific setup and authentication policy.
3. The two `FileCredentialStore` implementations already have different
   `modify()` semantics.
4. A shared Agent Home is not safe when CLI and Server refresh credentials at the
   same time because the stores only serialize writes within one process.

## Runtime Structure

```text
CLI adapter                    Server adapter
    |                               |
    | Agent commands                | Agent commands
    | auth interaction callbacks    | HTTP/SSE auth interaction bridge
    +---------------+---------------+
                    |
                    v
              Agent facade
      +-----------+------------+
      |           |            |
      v           v            v
ModelRuntime  AgentSettings  AgentSessionManager
- Models      - defaults     - Session discovery
- providers   - policy       - Session leases/storage
- credentials - agent.json   - AgentSession instances
- models
      |
      v
  @loopiq/ai (read-only dependency)
```

There is one Agent facade per application process. `createAgent()` constructs
one `ModelRuntime`, one `AgentSettings`, and one `AgentSessionManager`, and the
manager may host many Sessions. Each accepted request still creates one
short-lived `AgentRun`.

## Implemented Decisions

### D1. One Agent per process, many Sessions per Agent

An Agent is the process-level application runtime, not a conversation object.

```text
one process
  one Agent facade
    one ModelRuntime
    one AgentSettings
    one AgentSessionManager
      zero or more AgentSessions
        at most one active AgentRun per Session
```

The Server keeps one long-lived Agent. A standalone CLI invocation normally
creates one short-lived Agent and shuts it down before exit. Interactive CLI
mode keeps one Agent for the lifetime of the interactive process.

Consequences:

- Providers and credentials are shared by Sessions in the same process.
- Session transcript, selected model, thinking level, tools, and queues remain
  Session-owned.
- Creating a new Session does not create a new provider collection.

### D2. ModelRuntime owns provider and model behavior

`createAgent()` constructs an internal `ModelRuntime`; the thin facade only
delegates model/provider commands to it. `ModelRuntime` owns:

- the concrete `Models` collection from `@loopiq/ai`;
- registration of supported built-in providers;
- the persistent credential store;
- provider and model lookup;
- model catalog refresh;
- provider authentication status;
- same-Provider explicit credential-mutation exclusion;
- explicit credential addition, validation, replacement, and removal;
- switchable-model credential policy and model resolution;
- the model lookup and streaming capabilities supplied to `AgentEngine`.

`ModelRuntime` does not own Session state, prompts, tools, message history, or
adapter interaction policy.

Every Agent instance registers the following provider implementations during
local startup, whether or not a credential exists:

| Provider ID | Supported credential methods |
| --- | --- |
| `github-copilot` | OAuth, API token |
| `openai-codex` | OAuth |
| `openai` | API token |
| `anthropic` | OAuth, API token |
| `google` | API token |
| `openrouter` | API token |
| `deepseek` | API token |
| `moonshotai-cn` | API token |
| `minimax-cn` | API token |
| `zai-coding-cn` | API token |
| `kimi-coding` | API token |

Registration means the Agent knows the provider implementation, authentication
methods, and model catalog. It does not mean that the provider is configured,
authenticated, valid, selectable, or the default.

The supported-provider set is Agent application policy. Adding another
built-in provider later changes this table and the Agent-owned registration
list; it does not add provider assembly code to CLI or Server.

### D3. Public Agent construction has no persistence-location option

The public construction surface is:

```ts
export async function createAgent(): Promise<Agent>;
```

The asynchronous factory uses the single per-user Agent Home at `~/.loopiq`.
Adapters cannot choose another persistence root. The factory may create
directories, load Agent settings, and initialize stores. It must not
authenticate, prompt, or perform an online model refresh. Tests may inject a
temporary Agent Home through an internal helper that is not exported from the
package entry.

The concrete implementation class remains internal. The public `Agent`
type is the adapter-facing application interface. This prevents adapters from
bypassing construction invariants with `new Agent(...)`.

The public surface must not expose `Models`, `MutableModels`, `Provider`, or
`CredentialStore` from `@loopiq/ai`.

### D4. Creating an Agent never means logging in

Agent construction performs only local initialization:

```text
createAgent()
  -> load current Agent settings
  -> construct the credential store
  -> construct Models
  -> register built-in providers
  -> validate the locally known default model
  -> construct AgentSettings, AgentEngine, and AgentSessionManager
  -> return thin Agent facade
```

Construction does not:

- start GitHub device login;
- ask for terminal input;
- open a browser;
- require a credential to exist;
- refresh an OAuth token;
- make a provider network request.

Constructing an in-memory authentication manager on every Agent startup is not
the same as authenticating again. The manager reads or updates durable
credentials when an authentication-dependent operation needs them.

### D5. Authentication is explicit and adapter-neutral

The Agent exposes provider authentication operations without depending on a
terminal, HTTP, SSE, or browser API:

```ts
interface Agent {
  getProviderStatus(providerId: string): Promise<ProviderStatus>;
  addProviderCredential(
    providerId: string,
    options: AddProviderCredentialOptions,
  ): Promise<ProviderStatus>;
  validateProviderCredential(providerId: string): Promise<ProviderStatus>;
  removeProviderCredential(providerId: string): Promise<void>;
}

interface AddProviderCredentialOptions {
  method: "api_token" | "oauth";
  interaction: ProviderLoginInteraction;
}

interface ProviderLoginInteraction {
  signal?: AbortSignal;
  prompt(request: ProviderAuthPrompt): Promise<string>;
  notify(event: ProviderAuthEvent): void | Promise<void>;
}
```

The prompt and event unions are defined in the Agent package. They are mapped
internally to the `@loopiq/ai` login callbacks so adapters do not
need a direct `@loopiq/ai` dependency.

Adapter responsibilities are deliberately different from provider
responsibilities:

- CLI renders prompts and events on the terminal.
- Server maps prompts, events, cancellation, and completion to HTTP/SSE.
- The caller explicitly selects one of the methods advertised by the provider.
- Agent runs the selected authentication flow, verifies the resulting
  credential, and saves it only after successful verification.
- `@loopiq/ai` implements the provider-specific OAuth or API-key mechanics.

Server may own an in-memory login-job table so a multi-request HTTP interaction
can drive one blocking `addProviderCredential()` call. That table contains only
protocol state such as login IDs and pending prompt responses. It does not own
credentials or provider implementations. Settled jobs retain their event log
for five minutes so a client can reconnect and replay the terminal result, then
the Server removes the job and its listeners from memory.

Calling `addProviderCredential()` for a provider that already has a credential
is a replacement operation. The candidate credential is staged and verified
before the existing durable credential is replaced, so an invalid replacement
cannot destroy a working credential. Cancellation spans both provider login and
the validation request; an aborted candidate is never persisted.

### D6. No automatic interactive login

The Agent never turns a normal command into an interactive login. This keeps
headless and server behavior deterministic.

- `sessions list`, `sessions create`, Session inspection, and deletion work
  without authentication.
- An explicit login/token command or Server endpoint calls
  `addProviderCredential()`.
- A model run without usable authentication reports the request-time Provider
  or authentication failure through its normal Run result and does not silently
  start a login flow.
- CLI may print the exact login command required, but it must not prompt when a
  script expected non-interactive behavior.
- Server starts successfully while unauthenticated and exposes authentication
  status and login operations to its client.

The intended first-run flow is:

```text
create Agent
  -> no credential found
  -> non-model commands remain available
  -> user explicitly adds a provider credential
  -> Agent verifies and persists the credential
  -> current and future Agent instances can run models
```

### D7. Token refresh is automatic, login is not

When a stored OAuth access token expires, `@loopiq/ai` refreshes it inside
`CredentialStore.modify()`. The replacement credential is persisted before the
lock is released.

```text
model request
  -> read stored credential
  -> access token still valid: use it
  -> access token expired: lock, re-read, refresh once, persist, use it
  -> refresh fails: return an authentication failure
```

A successful refresh requires no CLI or Server interaction. If refresh can no
longer recover the account, the run fails and the user must explicitly log in
again. The failed credential is not silently replaced by an ambient environment
credential because that would change account identity unexpectedly.

Credential existence and credential validity are different states. A stored
credential may be expired, revoked, associated with the wrong service, or
temporarily unverifiable because the network is unavailable. Provider status
must preserve that distinction.

Verification is an authenticated online operation. Local parsing or successful
`Models.getAuth()` resolution alone cannot prove that a remote provider accepts
the credential. Each registered provider therefore has an Agent-owned
validation strategy, such as a provider-native authenticated status/catalog
request or a minimal validation request against a designated model.

Validation results are time-bound and include `validatedAt`. They may be cached
in memory for a short TTL, but each cache entry is bound to the exact persisted
credential that was validated. A credential replacement by another process
immediately makes the local status `unchecked`. If the durable credential
changes while an online validation is in flight, the Agent validates the new
current value before returning. Cached status is not treated as permanently true
and is not a substitute for normal provider error handling during a run.

### D8. Persistence is separated by concern

The data layout is:

```text
~/.loopiq/
  agent.json
  agent.lock/
  credentials.json
  credentials.lock/
  sessions/
    <sessionId>/
      session.jsonl
      runtime.lock
```

Ownership is:

| Data | Owner | Persistence |
| --- | --- | --- |
| Supported provider implementations | `ModelRuntime` | Application code |
| Global default model | Agent settings | `agent.json` |
| Global default thinking level | Agent settings | `agent.json` |
| Safe Provider request policy | Agent settings | `agent.json` |
| Provider credentials | Credential store | `credentials.json` |
| Credential validation result | `ModelRuntime` | Memory only |
| Session Workspace path | `AgentSessionManager` | `session.jsonl` header |
| Current Session model | `AgentSession` | `session.jsonl` |
| Session thinking level | `AgentSession` | `session.jsonl` |
| Dynamic provider/model objects | `ModelRuntime` | Memory only |
| Login prompts and pending responses | Adapter | Memory only |

`agent.json` contains one current shape with no version suffix:

```json
{
  "defaultModel": {
    "providerId": "github-copilot",
    "modelId": "claude-opus-4.6"
  },
  "defaultThinkingLevel": "high",
  "providerRequest": {
    "transport": "auto",
    "timeoutMs": 300000,
    "maxRetries": 0,
    "maxRetryDelayMs": 60000,
    "cacheRetention": "short"
  }
}
```

Provider implementation objects are never serialized. Credentials are never
written to `agent.json` or Session JSONL. Arbitrary request headers and metadata
are also unsupported because they may contain credentials, account identifiers,
or Provider-specific data. Model catalog caches, if dynamic providers later require
them, must use a separate cache file and must never be treated as configuration
or credentials.

The presence of a provider ID in `credentials.json` is the durable record that
the user supplied a credential. There is no duplicate enabled-provider list in
`agent.json`. Removing a credential removes that entry but does not unregister
the provider implementation.

### D9. Model selection has explicit precedence

For a new Session, model selection precedence is:

```text
explicit CreateSessionOptions.model
  > persisted Agent defaultModel
  > compiled application default
```

On first startup, the compiled application default is written to `agent.json`
so subsequent starts have one explicit global setting.

`defaultModel` is one atomic provider/model pair. It represents both the
default provider and that provider's corresponding default model; separate
fields must not be updated independently.

The Agent exposes `getConfiguration()` and `updateConfiguration()` so the pair
can be read and changed at runtime. Updating the default requires a registered
provider and a model in its known catalog, but it deliberately does not require
the provider to have a credential or a currently valid credential.

For an existing Session:

```text
explicit updateSession(model)
  > model already persisted in that Session
```

Opening or resuming an existing Session never replaces its model merely because
the global default changed. The global default affects only new Sessions.

If a persisted Session references an unsupported provider or unknown model,
open fails with a typed error. It must not silently move the Session to another
model or provider.

Creating a new Session from an unauthenticated default is allowed. `run()` still
returns a handle; when the first Provider request resolves authentication it may
use an ambient source supported by the Provider or fail through the normal
stream result until a credential is added. This preserves the requirement that
global configuration is independent from current authentication state.

Runtime Session switching is stricter than changing the default. Provider and
model are switched atomically through one `ModelReference`:

```ts
await agent.updateSession(sessionId, {
  model: { providerId, modelId },
});
```

The operation succeeds only when:

1. the provider is in the registered provider set;
2. a credential entry exists for that provider;
3. an online validation confirms that credential is currently usable;
4. the model exists in that provider's known model catalog.

Credential validity is provider-level evidence, not proof that the account is
entitled to every catalog model. A selected model can still be rejected by the
provider on its first real request. Model-specific entitlement probing would be
a separate, potentially billable operation and is not implied by provider
credential validation.

Changing only `providerId` is not supported because it could leave a model ID
that belongs to the previous provider. Changing models within the current
provider goes through the same atomic operation and validation rules.

### D10. Provider status and model listing belong to Agent

The Agent exposes application-level model operations:

```ts
interface Agent {
  listProviders(options?: ListProvidersOptions): Promise<ProviderSummary[]>;
  listModels(providerId?: string, options?: ListModelsOptions): Promise<ModelSummary[]>;
  getProviderStatus(providerId: string): Promise<ProviderStatus>;
  validateProviderCredential(providerId: string): Promise<ProviderStatus>;
  getConfiguration(): Promise<AgentConfiguration>;
  updateConfiguration(update: AgentConfigurationUpdate): Promise<AgentConfiguration>;
}
```

Returned values are Agent-owned serializable summaries, not objects from
`@loopiq/ai`.

`listProviders()` returns all eleven registered providers and their local
credential-presence state without network access. A `validateCredentials`
option performs online validation and returns status for each credential-backed
provider. UI switchers must display only entries whose resulting status is
`valid`; the Agent enforces the same rule when `updateSession()` is called, so a
client cannot bypass it.

Model listing uses the last known local catalog by default. An explicit refresh
option may perform network discovery for a dynamic provider. Listing models
must not start interactive login.

`getProviderStatus()` returns the current in-memory validation result when it is
still fresh; otherwise it reports only local credential presence as `unchecked`
or `missing`. `validateProviderCredential()` is the explicit online operation
that can also resolve and persist an expired OAuth-token refresh. Neither method
starts login.

Provider credential status distinguishes at least:

- `missing`: registered provider with no persisted credential;
- `unchecked`: a persisted credential exists but has not been validated in this
  process or its validation TTL expired;
- `valid`: online validation succeeded, with `validatedAt`;
- `invalid`: the provider rejected the credential;
- `unavailable`: validation could not complete because of network or provider
  availability, without claiming that the credential is invalid;
- unsupported provider.

Status must not expose credential values, authorization headers, refresh
tokens, or environment secrets.

### D11. Credential persistence is process-safe

There is one credential-store implementation in the Agent package. The previous
CLI and Server implementations have been deleted.

Required properties:

- `modify()` follows the `@loopiq/ai` contract: returning `undefined` means
  leave the current credential unchanged; deletion happens only through
  `delete()`.
- Writes use a cross-process lock because CLI and Server share the Agent Home.
- The lock covers the complete read-modify-write callback, including OAuth
  refresh, so two processes cannot refresh the same rotating token.
- Writes use a temporary file followed by atomic replacement.
- Credential files use owner-only permissions where the platform supports it.
- Reads never observe a partially written JSON document.
- A crashed lock owner can be detected and recovered without permanently
  disabling authentication.
- Logs and errors never include credential values.

Credentials are read from durable storage when needed rather than copied once
into an Agent-lifetime cache. Therefore an Agent process can observe a login or
refresh completed by another process sharing the same Agent Home. Online
validation also compares the durable credential again under the store lock, so
it never attaches an old credential's result to a concurrently replaced value.

`removeProviderCredential()` deletes only the credential. It does not remove
the registered provider, change the global default, or rewrite Sessions that
reference it. After deletion, that provider disappears from switchable-provider
results. Later Provider requests resolve authentication from the new durable
state and either use a Provider-supported ambient source or fail normally.

Active Runs do not reserve credentials and credential mutation does not inspect
active Runs. A request that already resolved authentication may finish with the
old credential; a later request can observe a replacement or removal. This race
is intentional: credentials are request-time capabilities, not structural Run
configuration. `ModelRuntime` retains a same-Provider mutation guard so two
explicit login/replacement/removal operations in one process cannot overlap;
the rejected mutation can be retried after the other mutation settles.

### D12. Agent settings use snapshot semantics

Agent settings are loaded during `createAgent()` into `AgentSettings` and form
that process's configuration snapshot. `updateConfiguration()` delegates to
`AgentSettings`, which updates both the in-memory snapshot and `agent.json`
through an atomic, cross-process-safe write.

The snapshot contains the default model, default thinking level, and safe
Provider request policy. The compiled thinking default is `high`. Default model
and thinking changes affect only new Sessions; existing Sessions retain their
JSONL-persisted values. Request policy is process-wide and each turn snapshot
reads its current value, so an update affects the next Provider request without
mutating one already in flight.

The request policy contains transport, a positive timeout, non-negative
Provider retry count, non-negative server-requested retry-delay cap, and cache
retention. Defaults are `auto`, `300000`, `0`, `60000`, and `short`. A zero
retry-delay cap means uncapped. Headers and metadata are not Agent settings or
runtime request options.

Direct external edits or another process's setting changes are not silently
injected into a running Agent. A later Agent instance sees them. If live reload
is needed later, it must be added as an explicit `reloadConfiguration()`
operation with defined event and conflict semantics.

This differs intentionally from credentials: credentials must be read fresh
because token rotation and login can occur in another process during normal
operation.

### D13. AgentEngine owns shared execution assets, not provider management

`AgentEngine` remains Session-stateless. It owns the System Prompt, Skills,
Prompt Templates, Session tool factory, model lookup/streaming capabilities,
Provider request policy access, and Turn snapshot assembly. It does not gain
provider registration, credential persistence, login, or catalog-refresh
responsibilities.

`ModelRuntime` supplies the narrow model lookup and streaming capabilities used
by the engine. The engine and `AgentRun` do not receive the credential store,
login operations, or mutable provider registry directly.

```text
Agent facade                     -> ModelRuntime management operations
Agent facade                     -> AgentSettings configuration operations
Agent facade                     -> AgentSessionManager Session operations
AgentEngine                      -> ModelRuntime getModel/streamSimple capabilities
AgentRun                         -> streaming capability captured by AgentEngine
```

This preserves the existing rule that an engine may be shared across Sessions
but must not hold current Session or run state.

### D14. CLI and Server become pure adapters

After the change, CLI and Server must not import `@loopiq/ai`.

CLI owns:

- argument parsing and commands;
- terminal prompt rendering for explicit login;
- output formatting and exit codes;
- signals and process lifetime.

Server owns:

- HTTP routing and validation;
- SSE delivery and redaction;
- login-job protocol state;
- browser Session selection;
- process lifetime.

Neither adapter owns:

- `createModels()`;
- provider registration;
- credential file format;
- OAuth token refresh;
- model resolution;
- provider-specific login selection.

The system prompt also becomes Agent-owned application behavior. CLI and Server
must not construct different Agent identities by passing different system
prompts.

### D15. The replaced path is removed

This project has no external consumers and is still under development. The
implementation replaced the previous path directly:

- remove `AgentOptions.models`;
- remove the public concrete Agent constructor;
- remove CLI and Server `FileCredentialStore` implementations;
- remove CLI and Server Copilot setup helpers;
- remove CLI and Server direct `@loopiq/ai` dependencies;
- remove old factories rather than forwarding them to the new API;
- use one current settings and credential shape without alternate parsers,
  aliases, or conversion branches.

Tests may inject internal fakes through private test helpers, but production
public APIs do not retain dependency-injection parameters solely for old
tests.

## Detailed Runtime Flows

### Agent startup with an existing credential

```text
CLI or Server
  -> await createAgent()
  -> Agent loads agent.json
  -> Agent creates ModelRuntime
  -> ModelRuntime registers all eleven supported providers
  -> Agent returns without reading or validating the credential online

later: run(Session)
  -> Agent accepts the Run and returns its handle
  -> first Provider request reads credentials.json
  -> request-time auth resolves or refreshes the credential
  -> provider request starts
```

There is no login during startup.

### First startup without a credential

```text
createAgent()
  -> succeeds

agent.listSessions()
  -> succeeds

agent.addProviderCredential("github-copilot", {
  method: "oauth",
  interaction,
})
  -> provider emits device-code/login events
  -> adapter renders or transports those events
  -> provider returns a candidate credential
  -> Agent validates the candidate online
  -> Agent saves it under the provider id only after validation succeeds
  -> credential addition completes

agent.run(sessionId, input)
  -> uses the saved credential
```

### Agent restart with persisted provider credentials

```text
createAgent()
  -> registers all eleven providers
  -> leaves credentials.json unchanged
  -> returns without prompting or online validation

agent.listProviders({ validateCredentials: true })
  -> reads persisted provider credentials
  -> validates them online
  -> returns valid/invalid/unavailable status

agent.run(sessionId, input)
  -> reuses the persisted credential
  -> does not ask the user to provide it again
```

Credential persistence removes the need to re-enter a token or repeat OAuth on
every launch. It cannot guarantee that the remote provider has not revoked the
credential since the previous process exited, so online operations still
handle revocation normally.

### Add or replace a provider credential at runtime

```text
agent.addProviderCredential(providerId, method, interaction)
  -> verify provider and method are registered
  -> complete API-token prompt or OAuth flow
  -> stage the candidate credential outside the durable store
  -> run the provider-specific authenticated validation strategy
  -> validation failed: preserve the previous credential, return an error
  -> validation succeeded: atomically replace credentials.json entry
  -> invalidate cached provider status
  -> return valid status with validatedAt
```

### Remove a provider credential at runtime

```text
agent.removeProviderCredential(providerId)
  -> serialize against another explicit mutation of the same provider
  -> atomically delete the credentials.json entry
  -> invalidate cached provider status
  -> keep provider registration, global default, and Session model references
  -> provider is no longer switchable
```

### Switch the active Session provider and model

```text
agent.updateSession(sessionId, {
  model: { providerId, modelId },
})
  -> verify provider is registered
  -> verify a persisted credential exists
  -> validate credential online, or use a still-current in-memory validation
  -> verify model belongs to the provider catalog
  -> persist the new provider/model pair in Session JSONL
  -> later turn snapshots use the new model
```

The provider and model change is one operation. There is no intermediate
Session state containing a new provider with the previous provider's model.

### Change the global default without a credential

```text
agent.updateConfiguration({
  defaultModel: { providerId, modelId },
})
  -> verify provider is registered
  -> verify model belongs to its catalog
  -> do not require or validate a credential
  -> atomically persist agent.json

createSession({ workspaceDir })
  -> uses the new default pair

run(newSession)
  -> returns a RunHandle
  -> actual Provider request uses ambient auth or fails until a credential is added
```

### Missing authentication during a run

```text
agent.run(sessionId, input)
  -> open Session
  -> reserve run ID and return RunHandle
  -> AgentRun starts the Provider request
  -> @loopiq/ai reads the current credential
  -> Provider auth setup or request reports the missing-auth failure
  -> Run settles as failed
  -> no interactive login starts
```

There is no authentication preflight. Missing authentication is ordinary Run
execution failure, so adapters receive the same handle, events, persisted error
message, and settlement lifecycle as other Provider failures.

### Expired OAuth access token

```text
first Provider request
  -> stored token is expired
  -> credential store acquires provider write lock
  -> re-reads current credential
  -> refreshes only if still expired
  -> atomically saves replacement credential
  -> releases lock
  -> Provider request continues
```

### Resume after global default changes

```text
Agent default model = Model B
Session JSONL model = Model A

open existing Session
  -> Model A

create new Session without explicit model
  -> Model B
```

### CLI and Server sharing one data directory

```text
Server Agent                        CLI Agent
    |                                  |
    +---- same credentials.json -------+
    +---- same agent.json -------------+
    +---- same sessions directory -----+
```

- Credential updates coordinate through the credential lock.
- Agent setting updates coordinate through the settings lock but do not live
  reload into the other process.
- Session mutation continues to coordinate through each Session's
  `runtime.lock`.

## Error Contract

The Agent exposes stable application errors rather than raw
`@loopiq/ai` errors. Required error categories are:

| Code | Meaning |
| --- | --- |
| `provider_not_found` | Provider is not supported by this Agent application |
| `model_not_found` | Model is not present in the provider catalog |
| `provider_auth_required` | An explicit management operation requires a persisted valid credential |
| `provider_credential_invalid` | Online validation proved that the credential is rejected |
| `provider_validation_unavailable` | Credential validity could not be established because validation was unavailable |
| `provider_busy` | Another explicit credential mutation is already active for the Provider |
| `provider_credential_canceled` | Credential entry or OAuth was canceled |
| `provider_credential_setup_failed` | Credential entry, OAuth, or validation failed |
| `credential_store` | Credential persistence or locking failed |
| `agent_configuration` | Agent settings are missing, invalid, or cannot be saved |

Errors may retain an internal `cause`, but serialized Server/CLI output must not
include secrets or sensitive provider response headers.

## File Placement

The implementation uses this ownership:

```text
packages/agent/src/
  agent.ts
  create-agent.ts
  configuration/
    agent-configuration.ts
    agent-settings.ts
    file-agent-settings-store.ts
  model/
    model-runtime.ts
    provider-types.ts
    builtin-providers.ts
    file-credential-store.ts
  session/
    agent-session-manager.ts
  persistence/
    file-lock.ts
    json-file.ts
```

Provider and credential behavior belongs under `model/`; Agent-wide settings
belong under `configuration/`; Session behavior belongs under `session/`.
Shared persistence files are dependency-leaf primitives and import no business
types. Platform usage does not justify a top-level technical bucket. No file is
added or changed under `packages/ai`.

## Implementation Record

1. Add Agent-owned serializable model/provider/auth types and errors.
2. Add a single file credential store with correct `modify()`, locking, atomic
   writes, permissions, and tests.
3. Add the Agent settings store and the single current `agent.json` shape.
4. Add `ModelRuntime` with the agreed eleven-provider registration list, model
   lookup, credential validation strategies, credential mutation, status, and
   stream capability.
5. Make `createAgent()` asynchronous and internalize concrete construction.
6. Route `AgentSessionManager` and `AgentEngine` model access through
   `ModelRuntime` capabilities.
7. Add Agent configuration, provider/model listing, credential
   add/validate/remove, and atomic Session model-switch operations.
8. Change CLI to use Agent operations and add explicit auth commands.
9. Change Server to use Agent operations and add adapter-owned login-job
   routes/events.
10. Delete duplicated stores, Copilot helpers, factories, and direct adapter
    dependencies on `@loopiq/ai`.
11. Update runtime documentation to mark the new ownership and flows as
    implemented.
12. Run build, type checking, unit tests, CLI integration tests, Server tests,
    and a shared-Agent-Home cross-process credential test.

Future changes to this behavior must update
[`multi-session-runtime.md`](./multi-session-runtime.md),
[`agent-runtime.md`](./agent-runtime.md), and
[`../architect.md`](../architect.md) where applicable.

## Test Contract

### Agent construction

- construction succeeds with no credential;
- construction performs no login prompt or provider network request;
- an existing credential is not rewritten during construction;
- invalid Agent settings fail deterministically.

### Authentication

- explicit API-key and OAuth login persistence;
- all eleven agreed providers are registered without credentials;
- only a provider with a persisted, valid credential is switchable;
- candidate credentials are validated before first persistence;
- invalid replacement credentials preserve the previous credential;
- invalid, unavailable, and unchecked validation states remain distinct;
- validation results expire and are refreshed before a later switch;
- cached validation is invalidated by a credential change from another process;
- a credential changed during validation is revalidated before success returns;
- cancel before prompt, during prompt, and during provider completion;
- credential removal deletes only the selected provider credential;
- removing a credential leaves provider registration, Agent default, and
  Session references unchanged;
- credential mutation may proceed while an active Run uses the Provider;
- an actual Provider request, not `Agent.run()`, resolves current authentication;
- missing auth settles the accepted Run through its normal failure path;
- expired access token refreshes and persists once;
- refresh failure settles the Run as failed without deleting the stored
  credential;
- credential values never appear in events or serialized errors.

### Concurrency and persistence

- concurrent refreshes in one process perform one refresh;
- concurrent refreshes in two processes perform one durable replacement;
- a crashed lock owner is recoverable;
- readers never observe partial JSON;
- `modify()` returning `undefined` preserves the current credential;
- `delete()` is serialized against refresh and login;
- settings writes are atomic and cross-process-safe.

### Model selection

- explicit new-Session model overrides the global default;
- the default provider/model pair can be saved without a credential;
- changing the global default affects only later Sessions;
- resuming a Session preserves its persisted model;
- Session provider/model switching is atomic;
- switching to a missing, invalid, or unavailable credential is rejected;
- switching models within a provider verifies catalog ownership;
- an unknown persisted provider/model fails instead of falling back;
- a model-dependent command works immediately after another process logs in.

### Adapter boundaries

- CLI and Server contain no direct `@loopiq/ai` imports;
- non-model CLI commands work without credentials;
- Server starts without credentials;
- CLI login and Server login use the same Agent operation;
- machine-readable CLI modes never mix auth diagnostics into stdout.

## Review Checklist

All recorded decisions below are implemented:

- [x] D1 — One Agent per process and many Sessions per Agent.
- [x] D2 — `ModelRuntime` owns provider/model behavior and registers the agreed eleven providers.
- [x] D3 — Public Agent construction is async, accepts no persistence-location option, and uses `~/.loopiq`.
- [x] D4 — Agent construction performs no login or provider network access.
- [x] D5 — `ModelRuntime` owns credential operations; the Agent facade exposes them and adapters provide interaction callbacks.
- [x] D6 — Login is always explicit; a normal run never opens an interactive flow.
- [x] D7 — Token refresh is automatic and durable; re-login remains explicit.
- [x] D8 — Settings, credentials, Session state, and validation cache remain separate.
- [x] D9 — Defaults may be unauthenticated; Session switching requires a valid credential.
- [x] D10 — Provider status, validation, model listing, and switching are Agent operations.
- [x] D11 — One process-safe credential store supports runtime add, replace, and removal.
- [x] D12 — `AgentSettings` uses per-process snapshot semantics.
- [x] D13 — Engine owns shared execution assets and narrow model capabilities,
  not authentication or provider management.
- [x] D14 — CLI and Server become adapters with no direct `@loopiq/ai` dependency.
- [x] D15 — Replaced implementations are deleted without forwarding wrappers.
