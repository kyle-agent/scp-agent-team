import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { assertAgentCard, type AgentCard } from '@scp/contracts';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo-root `agents/` by default; override with AGENTS_DIR for tests or deployment. */
export function defaultAgentsDir(): string {
  return process.env.AGENTS_DIR
    ? resolve(process.env.AGENTS_DIR)
    : resolve(here, '../../../agents');
}

const WRITE_VERBS = new Set([
  'apply',
  'patch',
  'delete',
  'exec',
  'create',
  'update',
  'scale',
  'restart',
  'rollout',
]);

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, '_');
}

/** Token-boundary match, so `dispatch_query` does not trip the `patch` rule. */
function containsTokenSequence(tokens: string[], sequence: string[]): boolean {
  if (sequence.length === 0) return false;
  for (let i = 0; i + sequence.length <= tokens.length; i++) {
    if (sequence.every((part, j) => tokens[i + j] === part)) return true;
  }
  return false;
}

/**
 * The one place agent definitions come from.
 *
 * Both access modes read this registry - the MCP tool catalog and the Portal
 * agent selector are two *views* of the same cards. There is deliberately no
 * way to register an agent for only one access mode (SPEC §12).
 */
export class AgentRegistry {
  private readonly byId = new Map<string, AgentCard>();

  private constructor(cards: AgentCard[]) {
    for (const card of cards) {
      if (this.byId.has(card.id)) {
        throw new Error(`duplicate agent id: ${card.id}`);
      }
      this.byId.set(card.id, card);
    }
  }

  static fromDirectory(dir: string = defaultAgentsDir()): AgentRegistry {
    if (!existsSync(dir)) throw new Error(`agents directory not found: ${dir}`);
    const cards: AgentCard[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cardPath = join(dir, entry.name, 'card.json');
      if (!existsSync(cardPath)) continue;
      const parsed: unknown = JSON.parse(readFileSync(cardPath, 'utf8'));
      try {
        assertAgentCard(parsed);
      } catch (err) {
        throw new Error(`invalid agent card at ${cardPath}: ${(err as Error).message}`);
      }
      cards.push(parsed);
    }
    if (cards.length === 0) throw new Error(`no agent cards found under ${dir}`);
    return new AgentRegistry(cards);
  }

  static fromCards(cards: AgentCard[]): AgentRegistry {
    cards.forEach(assertAgentCard);
    return new AgentRegistry(cards);
  }

  list(): AgentCard[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): AgentCard | undefined {
    return this.byId.get(id);
  }

  /** Throws with a message safe to return to a caller. */
  require(id: string): AgentCard {
    const card = this.get(id);
    if (!card) {
      throw new Error(
        `unknown agent "${id}". Available: ${this.list().map((c) => c.id).join(', ')}`,
      );
    }
    return card;
  }

  /**
   * Defence in depth for SPEC §14: even if a kagent agent is misconfigured with a
   * write tool, the gateway refuses to relay the run.
   */
  assertToolAllowed(agentId: string, toolName: string): void {
    const card = this.require(agentId);
    const tokens = normalizeToolName(toolName).split('_').filter(Boolean);

    for (const blocked of card.blocked_tools ?? []) {
      if (containsTokenSequence(tokens, normalizeToolName(blocked).split('_'))) {
        throw new Error(`tool "${toolName}" is blocked for agent "${agentId}"`);
      }
    }

    if (card.risk_level === 'read-only' && WRITE_VERBS.has(tokens[0] ?? '')) {
      throw new Error(
        `tool "${toolName}" is a write operation; agent "${agentId}" is read-only`,
      );
    }
  }
}
