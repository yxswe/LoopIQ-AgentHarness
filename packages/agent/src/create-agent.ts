import type { Agent, AgentOptions } from "./agent.ts";
import { createAgentFacade } from "./agent.ts";
import { DEFAULT_PROVIDER_REQUEST_POLICY, type ModelReference } from "./base/options.ts";
import type { AgentConfiguration } from "./configuration/agent-configuration.ts";
import { AgentSettings } from "./configuration/agent-settings.ts";
import { FileAgentSettingsStore } from "./configuration/file-agent-settings-store.ts";
import { AgentEngine } from "./engine/agent-engine.ts";
import { FileCredentialStore } from "./model/file-credential-store.ts";
import { ModelRuntime } from "./model/model-runtime.ts";
import { AgentSessionManager } from "./session/agent-session-manager.ts";
import { createDefaultTools } from "./tools/index.ts";

const COMPILED_DEFAULT_CONFIGURATION: AgentConfiguration = {
	defaultModel: { providerId: "github-copilot", modelId: "claude-opus-4.6" },
	defaultThinkingLevel: "high",
	providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
};

const AGENT_SYSTEM_PROMPT = "You are a helpful coding agent running inside LoopIQ Agent.";

export async function createAgent(options: AgentOptions): Promise<Agent> {
	// FileAgentSettingsStore owns the durable Agent-wide configuration at
	// `<dataDir>/agent.json`, including its mutation lock and atomic JSON replacement.
	// For example, with `dataDir: "/Users/alice/.loopiq"`, this object reads and
	// writes `/Users/alice/.loopiq/agent.json`. It does not keep provider credentials,
	// Session history, model objects, or any network client.
	const settingsStore = new FileAgentSettingsStore(options.dataDir);

	// `configuration` is the validated in-memory snapshot loaded from agent.json. It
	// currently contains exactly three Agent-wide choices: a default model reference
	// such as `github-copilot/claude-opus-4.6`, the default thinking level (`high`),
	// and the safe Provider request policy (transport, timeout, retry limits, and
	// cache retention). On first launch, loadOrCreate persists the compiled defaults;
	// later launches reuse the existing file. This initialization performs no login,
	// credential validation, catalog refresh, or other network operation.
	const configuration = await settingsStore.loadOrCreate(COMPILED_DEFAULT_CONFIGURATION);

	// FileCredentialStore owns `<dataDir>/credentials.json`, while ModelRuntime owns
	// all model-domain behavior above it. A newly constructed runtime has the eleven
	// supported Provider definitions registered (for example GitHub Copilot, OpenAI,
	// Anthropic, Google, and OpenRouter), the local credential store, Provider/model
	// catalog lookup, explicit OAuth/API-token setup and validation, credential
	// removal, and the short-lived validation cache. `modelRuntime.models` is a narrow
	// view of the same internal @loopiq/ai collection: AgentEngine can look up and
	// stream models, but cannot add or remove Provider registrations.
	const modelRuntime = new ModelRuntime({ credentials: new FileCredentialStore(options.dataDir) });

	// Ensure only that the configured reference exists in the already registered
	// local catalog. Passing `false` deliberately prevents an online catalog refresh,
	// so Agent construction remains local and does not require authentication.
	await modelRuntime.resolveModel(configuration.defaultModel, false);

	return composeAgent(options.dataDir, modelRuntime, configuration, settingsStore);
}

export async function createAgentForTesting(options: {
	dataDir: string;
	modelRuntime: ModelRuntime;
	defaultModel: ModelReference;
}): Promise<Agent> {
	const settingsStore = new FileAgentSettingsStore(options.dataDir);
	const configuration = await settingsStore.loadOrCreate({
		defaultModel: options.defaultModel,
		defaultThinkingLevel: "high",
		providerRequest: DEFAULT_PROVIDER_REQUEST_POLICY,
	});
	return composeAgent(options.dataDir, options.modelRuntime, configuration, settingsStore);
}

function composeAgent(
	dataDir: string,
	modelRuntime: ModelRuntime,
	configuration: AgentConfiguration,
	settingsStore: FileAgentSettingsStore,
): Agent {
	// AgentSettings is the sole owner of the live Agent configuration. It returns
	// defensive snapshots, validates configuration updates, persists before exposing
	// a new value, supplies defaults to newly created Sessions, and supplies the
	// current Provider request policy when a Turn starts. Existing Sessions keep their
	// own model and thinking-level choices; changing Agent defaults affects new ones.
	const settings = new AgentSettings(configuration, settingsStore, (reference) =>
		modelRuntime.resolveModel(reference),
	);

	// AgentEngine owns shared execution policy rather than Session state. It receives
	// model lookup/streaming, creates a fresh default tool set for each loaded Session
	// (Read, Write, Edit, Bash, Grep, Glob, and ListDir), captures the System Prompt,
	// and builds immutable per-Turn snapshots. Skills and Prompt Templates are empty
	// until they are explicitly wired here. Each accepted request gets a new AgentRun;
	// the engine itself owns no conversation history or active-run identity.
	const engine = new AgentEngine({
		models: modelRuntime.models,
		createTools: (env) => createDefaultTools(env),
		systemPrompt: AGENT_SYSTEM_PROMPT,
		getProviderRequestPolicy: () => settings.getProviderRequestPolicy(),
	});

	// AgentSessionManager owns Session identity and lifecycle under
	// `<dataDir>/sessions`. It discovers and opens JSONL stores, holds writer leases,
	// creates a NodeExecutionEnv and one tool set per loaded Session, restores each
	// Session's in-memory message/configuration state, routes run/steer/abort/events,
	// and closes resources. The two callbacks keep Agent defaults and model-switch
	// validation with their owning subsystems instead of duplicating that policy here.
	const sessions = new AgentSessionManager(
		dataDir,
		engine,
		() => settings.getSessionDefaults(),
		(reference) => modelRuntime.resolveSwitchableModel(reference),
	);

	// The returned Agent is intentionally only a public facade: every method performs
	// one-step delegation to ModelRuntime, AgentSettings, or AgentSessionManager.
	return createAgentFacade({ modelRuntime, sessions, settings });
}
