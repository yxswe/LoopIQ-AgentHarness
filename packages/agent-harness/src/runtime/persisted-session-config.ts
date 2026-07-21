import type { ThinkingLevel } from "../base/options.ts";

export const SESSION_CONFIG_CUSTOM_TYPE = "loopiq.session_config.v1";

export interface ModelReference {
	providerId: string;
	modelId: string;
}

export interface PersistedSessionConfigV1 {
	providerId: string;
	modelId: string;
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}
