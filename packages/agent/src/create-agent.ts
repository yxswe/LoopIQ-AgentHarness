import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "./agent.ts";
import { createAgentFacade } from "./agent.ts";
import { DEFAULT_PROVIDER_REQUEST_POLICY, type ModelReference } from "./base/options.ts";
import type { AgentConfiguration } from "./configuration/agent-configuration.ts";
import { AgentSettings } from "./configuration/agent-settings.ts";
import { FileAgentSettingsStore } from "./configuration/file-agent-settings-store.ts";
import { AgentEngine } from "./engine/agent-engine.ts";
import { FileCredentialStore } from "./model/file-credential-store.ts";
import { ModelRuntime } from "./model/model-runtime.ts";
import { AgentSessionManager } from "./session/agent-session-manager.ts";

const COMPILED_DEFAULT_CONFIGURATION: AgentConfiguration = {
	defaultModel: { providerId: "github-copilot", modelId: "claude-opus-4.6" },
	defaultThinkingLevel: "high",
	providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
};

type AgentConstructionOptions =
	| { agentHome: string }
	| { agentHome: string; modelRuntime: ModelRuntime; defaultModel: ModelReference };

export function createAgent(): Promise<Agent> {
	return createAgentInHome({ agentHome: join(homedir(), ".loopiq") });
}

export function createAgentForTesting(options: AgentConstructionOptions): Promise<Agent> {
	return createAgentInHome(options);
}

async function createAgentInHome(options: AgentConstructionOptions): Promise<Agent> {
	// FileAgentSettingsStore owns the durable Agent-wide configuration at
	// `<agentHome>/agent.json`, including its mutation lock and atomic JSON replacement.
	// The production Agent Home is always `~/.loopiq`, so this object reads and writes
	// `~/.loopiq/agent.json`. It does not keep provider credentials,
	// Session history, model objects, or any network client.
	const settingsStore = new FileAgentSettingsStore(options.agentHome);

	// `configuration` is the validated in-memory snapshot loaded from agent.json. It
	// currently contains exactly three Agent-wide choices: a default model reference
	// such as `github-copilot/claude-opus-4.6`, the default thinking level (`high`),
	// and the safe Provider request policy (transport, timeout, retry limits, and
	// cache retention). On first launch, loadOrCreate persists the production defaults
	// or the injected test model; later launches reuse the existing file. This
	// initialization performs no login, credential validation, catalog refresh, or
	// other network operation.
	const configuration = await settingsStore.loadOrCreate(
		"modelRuntime" in options
			? {
					defaultModel: options.defaultModel,
					defaultThinkingLevel: "high",
					providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
				}
			: COMPILED_DEFAULT_CONFIGURATION,
	);

	// FileCredentialStore owns `<agentHome>/credentials.json`, while ModelRuntime owns
	// all model-domain behavior above it. The production runtime has the eleven
	// supported Provider definitions registered (for example GitHub Copilot, OpenAI,
	// Anthropic, Google, and OpenRouter), the local credential store, Provider/model
	// catalog lookup, explicit OAuth/API-token setup and validation, credential removal,
	// and the short-lived validation cache. Tests may instead supply a runtime with a
	// controlled Provider. `modelRuntime.models` is a narrow view of the same internal
	// @loopiq/ai collection: AgentEngine can look up and stream models, but cannot add
	// or remove Provider registrations.
	const modelRuntime =
		"modelRuntime" in options
			? options.modelRuntime
			: new ModelRuntime({ credentials: new FileCredentialStore(options.agentHome) });

	// Ensure only that the configured reference exists in the already registered
	// local catalog. Passing `false` deliberately prevents an online catalog refresh,
	// so Agent construction remains local and does not require authentication.
	if (!("modelRuntime" in options)) await modelRuntime.resolveModel(configuration.defaultModel, false);

	// AgentSettings is the sole owner of the live Agent configuration. It returns
	// defensive snapshots, validates configuration updates, persists before exposing
	// a new value, supplies defaults to newly created Sessions, and supplies the
	// current Provider request policy when a Turn starts. Existing Sessions keep their
	// own model and thinking-level choices; changing Agent defaults affects new ones.
	const settings = new AgentSettings(configuration, settingsStore, (reference) =>
		modelRuntime.resolveModel(reference),
	);

	// AgentEngine owns shared execution policy rather than Session state. It receives
	// model lookup/streaming, takes its static System Prompt from
	// prompts/system-prompt.ts, and builds immutable per-Turn snapshots. Each accepted
	// request gets a new AgentRun; the engine itself owns no conversation history or
	// active-run identity.
	const engine = new AgentEngine({
		models: modelRuntime.models,
		getProviderRequestPolicy: () => settings.getProviderRequestPolicy(),
	});

	// AgentSessionManager owns Session identity and lifecycle under
	// `<agentHome>/sessions`. It discovers and opens JSONL stores, holds writer leases,
	// uses an Agent-Home filesystem adapter for JSONL persistence, and creates a separate
	// Workspace NodeExecutionEnv for each loaded Session. AgentSession uses that
	// Workspace environment to create and own its default Read, Write, Edit, Bash, Grep,
	// Glob, and ListDir instances. The manager also restores in-memory state, routes
	// run/steer/abort/events, and closes resources. The two callbacks keep Agent defaults
	// and model-switch validation with their owning subsystems.
	const sessions = new AgentSessionManager(
		options.agentHome,
		engine,
		() => settings.getSessionDefaults(),
		(reference) => modelRuntime.resolveSwitchableModel(reference),
	);

	// The returned Agent is intentionally only a public facade: every method performs
	// one-step delegation to ModelRuntime, AgentSettings, or AgentSessionManager.
	return createAgentFacade({ modelRuntime, sessions, settings });
}
