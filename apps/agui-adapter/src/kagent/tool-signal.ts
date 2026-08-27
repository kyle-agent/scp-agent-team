import type { A2APart } from './a2a.js';

export interface ToolCallSignal {
  phase: 'call';
  toolCallId: string;
  name: string;
  args?: unknown;
}
export interface ToolResultSignal {
  phase: 'result';
  toolCallId: string;
  name?: string;
  content: string;
}
export type ToolSignal = ToolCallSignal | ToolResultSignal;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function render(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * Recognise a tool call or tool result inside an A2A DataPart.
 *
 * There is no single normative shape for tool activity in A2A - it travels in
 * DataParts whose layout depends on the agent framework kagent is running
 * (ADK, LangGraph, CrewAI, ...). So this casts a deliberately wide net over the
 * shapes those frameworks emit.
 *
 * THIS IS THE ONE PLACE TO VERIFY AGAINST A REAL CLUSTER. Anything unrecognised
 * still reaches the Portal as a CUSTOM event rather than being dropped, so an
 * unmatched shape degrades the timeline instead of breaking the run - see
 * docs/access-mode-agui.md.
 */
export function detectToolSignal(part: A2APart): ToolSignal | undefined {
  if (part.kind !== 'data') return undefined;
  const data = (part as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;

  // ADK / Gemini function-call shape.
  const fnCall = d.functionCall ?? d.function_call;
  if (fnCall && typeof fnCall === 'object') {
    const f = fnCall as Record<string, unknown>;
    const name = str(f.name);
    if (name) {
      return {
        phase: 'call',
        toolCallId: str(f.id) ?? `tool-${name}-${Date.now()}`,
        name,
        args: f.args ?? f.arguments,
      };
    }
  }

  const fnResponse = d.functionResponse ?? d.function_response;
  if (fnResponse && typeof fnResponse === 'object') {
    const f = fnResponse as Record<string, unknown>;
    const name = str(f.name);
    return {
      phase: 'result',
      toolCallId: str(f.id) ?? `tool-${name ?? 'unknown'}`,
      name,
      content: render(f.response ?? f.result ?? f.output),
    };
  }

  // Generic / OpenAI-ish shapes used by LangGraph and CrewAI bridges.
  const marker = (str(d.kind) ?? str(d.type) ?? '').toLowerCase().replace(/[-\s]/g, '_');
  const toolCallId =
    str(d.tool_call_id) ?? str(d.toolCallId) ?? str(d.id) ?? undefined;
  const name = str(d.tool_name) ?? str(d.toolName) ?? str(d.name) ?? str(d.tool);

  const isResult =
    marker === 'tool_result' ||
    marker === 'tool_response' ||
    marker === 'tool_call_result' ||
    (toolCallId !== undefined && (d.result !== undefined || d.output !== undefined || d.response !== undefined));

  if (isResult && toolCallId) {
    return {
      phase: 'result',
      toolCallId,
      name,
      content: render(d.result ?? d.output ?? d.response ?? d.content),
    };
  }

  const isCall =
    marker === 'tool_call' ||
    marker === 'tool_use' ||
    marker === 'function_call' ||
    (name !== undefined && (d.args !== undefined || d.arguments !== undefined || d.input !== undefined));

  if (isCall && name) {
    return {
      phase: 'call',
      toolCallId: toolCallId ?? `tool-${name}-${Date.now()}`,
      name,
      args: d.args ?? d.arguments ?? d.input,
    };
  }

  return undefined;
}
