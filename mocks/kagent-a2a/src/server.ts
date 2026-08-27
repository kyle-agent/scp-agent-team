import { randomUUID } from 'node:crypto';
import express from 'express';
import { defaultFixture, fixtures } from './fixtures.js';

/**
 * Mock kagent A2A endpoint.
 *
 * Speaks the real wire format - JSON-RPC `message/stream` over SSE at
 * `/api/a2a/{namespace}/{agent}/` - so the adapter's production A2A client and
 * event mapper are the code actually exercised in mock mode. Only the agent's
 * reasoning is faked.
 */

const port = Number(process.env.MOCK_KAGENT_PORT ?? 8099);
const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, mock: true }));

app.get('/api/a2a/:namespace/:agent/.well-known/agent.json', (req, res) => {
  const { namespace, agent } = req.params;
  res.json({
    name: agent,
    description: `Mock kagent agent ${namespace}/${agent}`,
    url: `http://127.0.0.1:${port}/api/a2a/${namespace}/${agent}/`,
    version: '0.0.0-mock',
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  });
});

app.post('/api/a2a/:namespace/:agent/', async (req, res) => {
  const rpcId = req.body?.id ?? null;
  const method = req.body?.method;

  if (method !== 'message/stream') {
    res.status(400).json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32601, message: `mock supports message/stream only, got ${method}` },
    });
    return;
  }

  const fixture = fixtures[req.params.agent] ?? defaultFixture;
  const taskId = randomUUID();
  const contextId = req.body?.params?.message?.contextId ?? randomUUID();
  const messageId = `mock-msg-${taskId}`;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  // Listen on the *response*, not the request: `req` emits 'close' as soon as
  // its body has been consumed by the JSON parser, which would abort every run
  // before it started.
  let cancelled = false;
  res.on('close', () => {
    if (!res.writableFinished) cancelled = true;
  });

  const emit = (result: unknown): void => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, result })}\n\n`);
    }
  };

  const statusUpdate = (
    state: string,
    parts?: unknown[],
    final = false,
  ): void => {
    emit({
      kind: 'status-update',
      taskId,
      contextId,
      final,
      status: {
        state,
        timestamp: new Date().toISOString(),
        ...(parts ? { message: { kind: 'message', role: 'agent', messageId, parts } } : {}),
      },
    });
  };

  emit({
    kind: 'task',
    id: taskId,
    contextId,
    status: { state: 'submitted', timestamp: new Date().toISOString() },
  });

  // Text is streamed cumulatively on purpose: it is the harder of the two
  // real-world behaviours, and proves the adapter de-duplicates correctly.
  let cumulative = '';

  for (const step of fixture.steps) {
    if (cancelled) break;
    await sleep(step.delayMs ?? 150);

    if (step.planText) {
      // Character-level chunks on purpose: the `[PLAN]` markers end up split
      // across updates, which is what the adapter's filter has to survive.
      for (const chunk of chunkChars(step.planText, 3)) {
        if (cancelled) break;
        cumulative += chunk;
        statusUpdate('working', [{ kind: 'text', text: cumulative }]);
        await sleep(8);
      }
    }

    if (step.planData && !cancelled) {
      statusUpdate('working', [{ kind: 'data', data: { kind: 'plan', plan: step.planData } }]);
      await sleep(80);
    }

    if (step.planStep && !cancelled) {
      statusUpdate('working', [{ kind: 'data', data: { kind: 'plan-step', ...step.planStep } }]);
      await sleep(80);
    }

    if (step.text) {
      for (const chunk of chunkText(step.text)) {
        if (cancelled) break;
        cumulative += chunk;
        statusUpdate('working', [{ kind: 'text', text: cumulative }]);
        await sleep(25);
      }
    }

    if (step.tool && !cancelled) {
      statusUpdate('working', [
        {
          kind: 'data',
          data: {
            kind: 'tool-call',
            tool_call_id: `call-${step.tool.name}-${fixture.steps.indexOf(step)}`,
            name: step.tool.name,
            args: step.tool.args,
          },
        },
      ]);
      await sleep(step.delayMs ?? 200);
      statusUpdate('working', [
        {
          kind: 'data',
          data: {
            kind: 'tool-result',
            tool_call_id: `call-${step.tool.name}-${fixture.steps.indexOf(step)}`,
            name: step.tool.name,
            result: step.tool.result,
          },
        },
      ]);
    }
  }

  if (cancelled) {
    res.end();
    return;
  }

  emit({
    kind: 'artifact-update',
    taskId,
    contextId,
    lastChunk: true,
    artifact: {
      artifactId: `${taskId}-result`,
      name: 'agent-result',
      parts: [{ kind: 'data', data: fixture.result }],
    },
  });

  statusUpdate('completed', undefined, true);
  res.end();
});

function chunkText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function chunkChars(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.listen(port, () => {
  console.log(`[mock-kagent] A2A on :${port} - agents: ${Object.keys(fixtures).join(', ')}`);
});
