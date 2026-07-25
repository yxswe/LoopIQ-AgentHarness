import type { ThinkingLevel } from "../base/options.ts";

export const SESSION_CONFIG_CUSTOM_TYPE = "loopiq.session_config";

export interface ModelReference {
	providerId: string;
	modelId: string;
}

export interface PersistedSessionConfig {
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}
