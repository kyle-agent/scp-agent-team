import type { A2AMessage, A2APart } from './a2a.js';
import type { ToolSignal } from './tool-signal.js';

export interface DelegationStart {
  phase: 'start';
  name: string;
  description?: string;
  parentToolCallId?: string;
}
export interface DelegationEnd {
  phase: 'end';
  name?: string;
  parentToolCallId?: string;
  result?: unknown;
}
export type DelegationSignal = DelegationStart | DelegationEnd;

/** Tool names that mean "hand this to another agent" rather than "run a tool". */
const TRANSFER_TOOLS = new Set([
  'transfer_to_agent',
  'transfer_to',
  'delegate_to_agent',
  'delegate',
  'call_agent',
  'invoke_agent',
  'send_to_agent',
  'handoff',
  'handoff_to_agent',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Decides whether a tool call is really a delegation to another agent.
 *
 * Two ways it shows up in practice:
 *   - an explicit transfer tool, with the target named in the arguments
 *   - a tool whose *name* is an agent (how a supervisor calls its specialists)
 *
 * `knownAgents` carries the second case: the shared agent ids from the registry.
 * Without it a supervisor calling `kubernetes_agent` looks like an ordinary tool.
 */
export function delegationFromTool(
  signal: ToolSignal,
  knownAgents: ReadonlySet<string>,
): DelegationSignal | undefined {
  const name = normalize(signal.phase === 'call' ? signal.name : (signal.name ?? ''));

  if (TRANSFER_TOOLS.has(name)) {
    if (signal.phase === 'call') {
      const args = (signal.args ?? {}) as Record<string, unknown>;
      const target =
        str(args.agent_name) ?? str(args.agentName) ?? str(args.agent) ?? str(args.name);
      // A transfer with no named target tells the user nothing useful; leave it
      // as an ordinary tool row rather than inventing an agent.
      if (!target) return undefined;
      const description = str(args.task) ?? str(args.request) ?? str(args.message);
      return {
        phase: 'start',
        name: target,
        ...(description ? { description } : {}),
        parentToolCallId: signal.toolCallId,
      };
    }
    return { phase: 'end', parentToolCallId: signal.toolCallId, result: signal.content };
  }

  if (knownAgents.has(name)) {
    return signal.phase === 'call'
      ? { phase: 'start', name, parentToolCallId: signal.toolCallId }
      : { phase: 'end', name, parentToolCallId: signal.toolCallId, result: signal.content };
  }

  return undefined;
}

/** An explicit delegation DataPart, for agents that report collaboration directly. */
export function delegationFromPart(part: A2APart): DelegationSignal | undefined {
  if (part.kind !== 'data') return undefined;
  const data = (part as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;

  const marker = normalize(str(d.kind) ?? str(d.type) ?? '');
  const name = str(d.agent) ?? str(d.agent_name) ?? str(d.agentName) ?? str(d.name);

  if (marker === 'agent_call' || marker === 'delegation' || marker === 'subagent_started') {
    if (!name) return undefined;
    const description = str(d.task) ?? str(d.description);
    return { phase: 'start', name, ...(description ? { description } : {}) };
  }
  if (marker === 'agent_result' || marker === 'subagent_finished') {
    return { phase: 'end', ...(name ? { name } : {}), result: d.result ?? d.output };
  }
  return undefined;
}

/**
 * The agent a message came from, when the stream says so.
 *
 * ADK-derived runtimes tag events with the author, which is the only delegation
 * signal available when a supervisor's sub-agents are invoked internally rather
 * than through a visible tool call.
 */
export function authorOf(message: A2AMessage): string | undefined {
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (!meta) return undefined;
  return (
    str(meta.author) ??
    str(meta.agent) ??
    str(meta.agent_name) ??
    str(meta.agentName) ??
    undefined
  );
}
