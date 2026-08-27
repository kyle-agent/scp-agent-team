import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { AgentRegistry } from '@scp/agent-registry';
import {
  ContractError,
  assertAgentInvocation,
  type AgentInvocation,
  type AuditRecord,
  type PlanStep,
} from '@scp/contracts';
import { loadConfig } from './config.js';
import { bearerAuth } from './auth.js';
import { AuditLog } from './audit.js';
import { A2AAgentInvoker, type AgentInvoker } from './invoker.js';
import { encodeSse, type AguiEvent } from './agui/events.js';

const config = loadConfig();
const registry = AgentRegistry.fromDirectory(config.agentsDir);
const audit = new AuditLog(config.auditFile);

const invoker: AgentInvoker = new A2AAgentInvoker({
  baseUrl: config.kagentBaseUrl,
  registry,
  buildHeaders: () => ({}),
});

/** Live runs, so an explicit cancel can abort the upstream A2A call. */
const activeRuns = new Map<string, AbortController>();
/** Portal session -> kagent contextId, so follow-ups continue the conversation. */
const sessionContexts = new Map<string, string>();
/**
 * Threads paused waiting for the user.
 *
 * Held server-side rather than handed to the browser: the kagent task id is a
 * backend identifier, and the Portal has no reason to carry one.
 */
const awaitingInput = new Map<
  string,
  { taskId?: string; agent: string; plan?: PlanStep[] }
>();

const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: false }));
app.use(express.json({ limit: '2mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, invoker: invoker.kind, kagent: config.kagentBaseUrl });
});

app.use(bearerAuth(config.apiToken));

/** The Portal agent catalog. Same registry the MCP tool catalog will use. */
app.get('/api/agents', (_req, res) => {
  res.json({ agents: registry.list() });
});

app.post('/api/runs/:runId/cancel', (req, res) => {
  const controller = activeRuns.get(req.params.runId);
  if (!controller) {
    res.status(404).json({ error: 'run not found or already finished' });
    return;
  }
  controller.abort();
  res.json({ ok: true });
});

/**
 * AG-UI run endpoint: POST in, Server-Sent Events out.
 *
 * The response is a stream of AG-UI events for exactly one agent run.
 */
app.post('/agui/run', async (req, res) => {
  const auth = req.auth!;
  const started = Date.now();
  const body = (req.body ?? {}) as Record<string, unknown>;

  const threadId = typeof body.threadId === 'string' ? body.threadId : randomUUID();
  const runId = typeof body.runId === 'string' ? body.runId : randomUUID();

  // Answering a question resumes the paused kagent task rather than starting a
  // fresh one, so the agent keeps everything it had already established.
  const parked = body.resume === true ? awaitingInput.get(threadId) : undefined;
  if (body.resume === true && !parked) {
    res.status(409).json({ error: 'nothing is waiting for input on this thread' });
    return;
  }
  if (parked) awaitingInput.delete(threadId);

  const invocation: AgentInvocation = {
    request_id: typeof body.request_id === 'string' ? body.request_id : randomUUID(),
    agent: parked ? parked.agent : String(body.agent ?? ''),
    task: String(body.task ?? ''),
    context: (body.context as AgentInvocation['context']) ?? undefined,
    artifacts: (body.artifacts as AgentInvocation['artifacts']) ?? undefined,
    constraints: (body.constraints as string[]) ?? undefined,
    actor: { type: 'portal', user_id: auth.userId, client: auth.client },
    correlation: {
      trace_id: typeof body.trace_id === 'string' ? body.trace_id : randomUUID(),
      session_id: threadId,
    },
  };

  // Validate before opening the stream, so a bad request gets a real HTTP error
  // instead of a 200 that immediately errors.
  try {
    assertAgentInvocation(invocation);
    registry.require(invocation.agent);
  } catch (err) {
    const status = err instanceof ContractError ? 400 : 404;
    res.status(status).json({ error: (err as Error).message });
    audit.write(auditRecord(invocation, auth.accessMode, started, 'rejected', [], (err as Error).message));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-scp-run-id': runId,
    'x-scp-trace-id': invocation.correlation.trace_id,
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  activeRuns.set(runId, controller);
  const timeout = setTimeout(() => controller.abort(), config.runTimeoutMs);
  // On the response, not the request: `req` emits 'close' once its body has been
  // parsed, which would abort every run immediately.
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  const send = (event: AguiEvent): void => {
    if (!res.writableEnded) res.write(encodeSse(event));
  };

  let status = 'completed';
  let error: string | undefined;

  try {
    const run = invoker.run(invocation, {
      threadId,
      runId,
      signal: controller.signal,
      contextId: sessionContexts.get(threadId),
      ...(parked?.taskId ? { resumeTaskId: parked.taskId } : {}),
      ...(parked?.plan ? { resumePlan: parked.plan } : {}),
    });

    // Manual iteration: the generator's *return value* is the AgentResult, which
    // `for await` would discard.
    for (;;) {
      const next = await run.next();
      if (next.done) {
        status = next.value.status;
        error = next.value.error?.message;
        break;
      }
      send(next.value);
    }

    const contextId = invoker.contextIdFor(runId);
    if (contextId) sessionContexts.set(threadId, contextId);

    const pending = invoker.pendingFor(runId);
    if (pending) {
      awaitingInput.set(threadId, {
        ...(pending.taskId ? { taskId: pending.taskId } : {}),
        agent: invocation.agent,
        ...(pending.plan ? { plan: pending.plan } : {}),
      });
    }
  } catch (err) {
    status = 'failed';
    error = (err as Error).message;
    send({ type: 'RUN_ERROR', message: error, code: 'ADAPTER_ERROR' });
  } finally {
    clearTimeout(timeout);
    activeRuns.delete(runId);
    audit.write(
      auditRecord(
        invocation,
        auth.accessMode,
        started,
        status,
        invoker.toolsFor(runId).map((t) => ({
          tool_call_id: t.tool_call_id,
          name: t.name,
          ...(t.subagent ? { subagent: t.subagent } : {}),
        })),
        error,
        runId,
        invoker.participantsFor(runId),
      ),
    );
    if (!res.writableEnded) res.end();
  }
});

function auditRecord(
  invocation: AgentInvocation,
  accessMode: AuditRecord['access_mode'],
  started: number,
  status: string,
  tools: AuditRecord['tools'],
  error?: string,
  runId?: string,
  participants: string[] = [],
): AuditRecord {
  return {
    ts: new Date().toISOString(),
    trace_id: invocation.correlation.trace_id,
    request_id: invocation.request_id,
    session_id: invocation.correlation.session_id,
    user: invocation.actor.user_id,
    access_mode: accessMode,
    client: invocation.actor.client,
    agent: invocation.agent,
    agent_run_id: runId,
    ...(participants.length > 0 ? { participants } : {}),
    tools,
    duration_ms: Date.now() - started,
    status,
    error,
  };
}

const server = app.listen(config.port, () => {
  console.log(
    `[agui-adapter] listening on :${config.port} -> kagent ${config.kagentBaseUrl} (${registry.list().map((a) => a.id).join(', ')})`,
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[agui-adapter] port ${config.port} is already in use. Another adapter is probably still running - stop it, or set PORT.`,
    );
  } else {
    console.error(`[agui-adapter] failed to start: ${err.message}`);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const controller of activeRuns.values()) controller.abort();
    server.close(() => process.exit(0));
  });
}
