import type { AgentCard } from '@scp/contracts';
import type { AguiEvent } from './agui-events';

const TOKEN = import.meta.env.VITE_SCP_API_TOKEN ?? 'dev-token';
const USER = import.meta.env.VITE_SCP_USER ?? 'portal-dev-user';

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'x-scp-user': USER,
    'x-scp-client': 'scp-portal',
  };
}

export async function fetchAgents(): Promise<AgentCard[]> {
  const res = await fetch('/api/agents', { headers: authHeaders() });
  if (!res.ok) throw new Error(`agent catalog failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { agents: AgentCard[] };
  return body.agents;
}

export interface RunRequest {
  agent: string;
  task: string;
  threadId: string;
  runId: string;
  context?: Record<string, string>;
  constraints?: string[];
  artifacts?: { name: string; media_type?: string; content: string }[];
  /**
   * Answers a question the agent paused on, resuming its kagent task.
   *
   * The adapter holds the task id server-side, so the browser only has to say
   * which thread it is answering.
   */
  resume?: boolean;
}

/**
 * Opens the AG-UI run stream and yields decoded events.
 *
 * Uses fetch + ReadableStream rather than EventSource because the run is a POST
 * carrying the invocation, and because it needs an Authorization header -
 * EventSource supports neither.
 */
export async function* runAgent(
  request: RunRequest,
  signal: AbortSignal,
): AsyncGenerator<AguiEvent> {
  const res = await fetch('/agui/run', {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(detail || `run failed: ${res.status}`);
  }
  if (!res.body) throw new Error('run returned no stream');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);

        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;

        try {
          yield JSON.parse(data) as AguiEvent;
        } catch {
          // Ignore an unparseable frame rather than tearing down the run.
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST',
    headers: authHeaders(),
  }).catch(() => {});
}
