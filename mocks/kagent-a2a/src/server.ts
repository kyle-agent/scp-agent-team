import { randomUUID } from 'node:crypto';
import express from 'express';
import { defaultFixture, fixtures, hitlFixtures, type Fixture, type ScriptStep } from './fixtures.js';

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

/**
 * Tasks paused in `input-required`, with the steps still to run.
 *
 * A real kagent keeps this in the task itself; the mock only has to remember
 * where it stopped so a resume can pick up from there.
 */
const parkedTasks = new Map<string, { fixture: Fixture; remaining: ScriptStep[]; cumulative: string }>();

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

  const inbound = req.body?.params?.message;
  const askedText: string = (inbound?.parts ?? [])
    .filter((p: { kind?: string }) => p?.kind === 'text')
    .map((p: { text?: string }) => p.text ?? '')
    .join(' ');

  // A message carrying a taskId is an answer to a question, not a new task.
  const resumeTaskId: string | undefined = inbound?.taskId;
  const parked = resumeTaskId ? parkedTasks.get(resumeTaskId) : undefined;
  if (resumeTaskId && !parked) {
    res.status(404).json({
      jsonrpc: '2.0',
      id: rpcId,
      error: { code: -32001, message: `no task ${resumeTaskId} is awaiting input` },
    });
    return;
  }
  if (resumeTaskId) parkedTasks.delete(resumeTaskId);

  const fixture =
    parked?.fixture ??
    hitlFixtures.find((f) => f.agent === req.params.agent && f.match.test(askedText))?.fixture ??
    fixtures[req.params.agent] ??
    defaultFixture;

  const taskId = resumeTaskId ?? randomUUID();
  const contextId = inbound?.contextId ?? randomUUID();
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
  // A resumed task continues rather than replaying: the adapter has already
  // shown everything said before the pause.
  let cumulative = '';
  let paused = false;

  const runSteps = async (steps: ScriptStep[]): Promise<void> => {
    for (const [index, step] of steps.entries()) {
      if (cancelled || paused) return;

      if (step.askUser) {
        // Park the rest of the script and stop the stream. Nothing after this
        // runs until an answer arrives on this same task.
        parkedTasks.set(taskId, {
          fixture,
          remaining: steps.slice(index + 1),
          cumulative,
        });
        paused = true;
        statusUpdate(
          'input-required',
          [{ kind: 'data', data: { kind: 'input-request', ...step.askUser } }],
          true,
        );
        return;
      }

      await sleep(step.delayMs ?? 150);

      if (step.planText) {
        // Character-level chunks on purpose: the `[PLAN]` markers end up split
        // across updates, which is what the adapter's filter has to survive.
        for (const chunk of chunkChars(step.planText, 3)) {
          if (cancelled) return;
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
          if (cancelled) return;
          cumulative += chunk;
          statusUpdate('working', [{ kind: 'text', text: cumulative }]);
          await sleep(25);
        }
      }

      if (step.tool && !cancelled) {
        const callId = nextCallId(step.tool.name);
        statusUpdate('working', [
          {
            kind: 'data',
            data: {
              kind: 'tool-call',
              tool_call_id: callId,
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
              tool_call_id: callId,
              name: step.tool.name,
              result: step.tool.result,
            },
          },
        ]);
      }

      if (step.delegate && !cancelled) {
        // A delegation on the wire is a transfer tool call whose result arrives
        // once the other agent is done. Its own work streams in between.
        const callId = nextCallId('transfer_to_agent');
        statusUpdate('working', [
          {
            kind: 'data',
            data: {
              kind: 'tool-call',
              tool_call_id: callId,
              name: 'transfer_to_agent',
              args: { agent_name: step.delegate.agent, task: step.delegate.task },
            },
          },
        ]);

        await runSteps(step.delegate.steps);
        if (cancelled) return;

        statusUpdate('working', [
          {
            kind: 'data',
            data: {
              kind: 'tool-result',
              tool_call_id: callId,
              name: 'transfer_to_agent',
              result: step.delegate.result,
            },
          },
        ]);
      }
    }
  };

  await runSteps(parked?.remaining ?? fixture.steps);

  if (paused) {
    res.end();
    return;
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

let callSequence = 0;
function nextCallId(name: string): string {
  return `call-${name}-${++callSequence}`;
}

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
