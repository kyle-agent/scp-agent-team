import type { AgentCard, AgentInvocation } from '@scp/contracts';

const MAX_ARTIFACT_CHARS = 60_000;

/**
 * Flattens the invocation contract into the single text part A2A carries.
 *
 * The contract is the interface; this is only its wire encoding. When kagent
 * agents learn to accept structured input directly, replace this - nothing else
 * changes.
 */
export function composePrompt(invocation: AgentInvocation, card: AgentCard): string {
  const sections: string[] = [invocation.task.trim()];

  const context = Object.entries(invocation.context ?? {}).filter(
    ([, v]) => v !== undefined && v !== '',
  );
  if (context.length > 0) {
    sections.push(
      ['## Context', ...context.map(([k, v]) => `- ${k}: ${String(v)}`)].join('\n'),
    );
  }

  if (invocation.constraints?.length) {
    sections.push(
      ['## Constraints', ...invocation.constraints.map((c) => `- ${c}`)].join('\n'),
    );
  }

  let budget = MAX_ARTIFACT_CHARS;
  for (const artifact of invocation.artifacts ?? []) {
    if (budget <= 0) {
      sections.push(`_(further artifacts omitted: context size limit)_`);
      break;
    }
    const content = artifact.content.slice(0, budget);
    budget -= content.length;
    const fence = artifact.media_type?.includes('yaml') ? 'yaml' : '';
    sections.push(`## Artifact: ${artifact.name}\n\`\`\`${fence}\n${content}\n\`\`\``);
  }

  sections.push(
    `_You are ${card.name}, a shared SCP agent. You are read-only; recommend actions rather than performing them._`,
  );

  return sections.join('\n\n');
}
