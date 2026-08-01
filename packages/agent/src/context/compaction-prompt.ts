export const CONTEXT_SUMMARY_PREFIX = `The following is a compacted summary of earlier conversation context.

<context-summary>
`;

export const CONTEXT_SUMMARY_SUFFIX = `
</context-summary>`;

export const COMPACTION_SYSTEM_PROMPT = `You summarize conversation context for another language model that will continue the same work.

Do not continue the conversation or answer its requests. Output only the requested structured summary. Preserve exact paths, identifiers, commands, errors, decisions, constraints, completed work, and remaining work. Do not invent facts.`;

export function buildCompactionPrompt(input: {
	conversation: string;
	previousSummary?: string;
	instructionPrefix?: string;
}): string {
	const sections = [`<conversation>\n${input.conversation}\n</conversation>`];
	if (input.previousSummary) {
		sections.push(`<previous-summary>\n${input.previousSummary}\n</previous-summary>`);
	}
	if (input.instructionPrefix) {
		sections.push(`<instruction-prefix>\n${input.instructionPrefix}\n</instruction-prefix>`);
	}
	sections.push(`${input.previousSummary ? "Update" : "Create"} the context summary using this exact structure:

## Goal
[The user's current objective]

## Constraints & Preferences
- [Requirements and preferences]

## Progress
### Done
- [Completed work]

### In Progress
- [Current work]

### Blocked
- [Current blockers, or "None"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Facts needed to continue]

Preserve still-relevant information from <previous-summary>. The optional <instruction-prefix> is the removed beginning of a long instruction span whose recent suffix remains verbatim; preserve its original request, early progress, and the facts needed to understand that suffix.`);
	return sections.join("\n\n");
}
