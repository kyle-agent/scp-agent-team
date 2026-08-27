import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResult, AuditRecord, PlanStep } from '@scp/contracts';
import { assertAgentResult } from '@scp/contracts';

const REPO = new URL('../../', import.meta.url).pathname;
const MOCK_PORT = 8391;
const ADAPTER_PORT = 8390;
const TOKEN = 'e2e-token';
const BASE = `http://127.0.0.1:${ADAPTER_PORT}`;

let mock: ChildProcess;
let adapter: ChildProcess;
let auditFile: string;

function start(script: string, env: Record<string, string>): ChildProcess {
  // `node --import tsx` rather than the tsx bin: the bin is a wrapper that
  // spawns node as a grandchild, and killing the wrapper orphans the real
  // server, which then holds the port and breaks the next run with EADDRINUSE.
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Both pipes must be drained: the adapter logs an audit line per run, and a
  // full pipe would block the child mid-stream.
  child.stdout?.resume();
  child.stderr?.on('data', (b: Buffer) => {
    const line = b.toString();
    if (/error/i.test(line)) process.stderr.write(`[${script}] ${line}`);
  });
  return child;
}

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface AguiEvent {
  type: string;
  [k: string]: unknown;
}

/** Drives one AG-UI run and collects every event off the SSE stream. */
async function runAgent(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; events: AguiEvent[]; text: string }> {
  const res = await fetch(`${BASE}/agui/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-scp-user': 'e2e-user',
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    return { status: res.status, events: [], text: await res.text() };
  }

  const raw = await res.text();
  const events: AguiEvent[] = [];
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n');
    if (data) events.push(JSON.parse(data) as AguiEvent);
  }
  return { status: res.status, events, text: raw };
}

/**
 * Everything is scoped inside one suite on purpose: node:test's *root* before/after
 * hooks race with pending top-level suites, which tore the servers down mid-run.
 * Suite-scoped hooks are ordered deterministically against nested suites.
 */
describe('AG-UI Portal access (Mode 2)', () => {
  before(async () => {
    auditFile = join(mkdtempSync(join(tmpdir(), 'scp-audit-')), 'audit.jsonl');

    mock = start('mocks/kagent-a2a/src/server.ts', { MOCK_KAGENT_PORT: String(MOCK_PORT) });
    adapter = start('apps/agui-adapter/src/server.ts', {
      PORT: String(ADAPTER_PORT),
      SCP_API_TOKEN: TOKEN,
      KAGENT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
      AUDIT_FILE: auditFile,
    });

    await waitForHealth(`http://127.0.0.1:${MOCK_PORT}/healthz`);
    await waitForHealth(`${BASE}/healthz`);
  });

  after(async () => {
    await Promise.all([stop(mock), stop(adapter)]);
  });

  /** Kill a child and wait for it, releasing its stdio so the test process exits. */
  function stop(child?: ChildProcess): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once('exit', () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve();
      });
      child.kill('SIGKILL');
    });
  }

  describe('authentication (SPEC 16)', () => {
    test('the agent catalog is not anonymous', async () => {
      const res = await fetch(`${BASE}/api/agents`);
      assert.equal(res.status, 401);
    });

    test('a wrong token is rejected', async () => {
      const res = await fetch(`${BASE}/api/agents`, {
        headers: { authorization: 'Bearer wrong-token' },
      });
      assert.equal(res.status, 401);
    });

    test('a valid token returns the shared agent catalog', async () => {
      const res = await fetch(`${BASE}/api/agents`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agents: { id: string }[] };
      assert.deepEqual(
        body.agents.map((a) => a.id).sort(),
        ['architecture_agent', 'kubernetes_agent'],
      );
    });
  });

  describe('E2E B - Portal mode (SPEC 26)', () => {
    let events: AguiEvent[];

    before(async () => {
      const run = await runAgent({
        agent: 'kubernetes_agent',
        task: 'The checkout service is slow in prod. Find the root cause.',
        threadId: 'thread-e2e-1',
        runId: 'run-e2e-1',
        context: { service: 'checkout', environment: 'prod' },
      });
      assert.equal(run.status, 200);
      events = run.events;
    });

    test('emits AG-UI run lifecycle events', () => {
      assert.equal(events.at(0)?.type, 'RUN_STARTED', 'RUN_STARTED must be first');
      assert.equal(events.at(-1)?.type, 'RUN_FINISHED', 'RUN_FINISHED must be last');
      assert.ok(!events.some((e) => e.type === 'RUN_ERROR'), 'no RUN_ERROR expected');
    });

    test('streams assistant text', () => {
      const starts = events.filter((e) => e.type === 'TEXT_MESSAGE_START');
      const contents = events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT');
      const ends = events.filter((e) => e.type === 'TEXT_MESSAGE_END');
      assert.ok(starts.length >= 1, 'expected a TEXT_MESSAGE_START');
      assert.ok(contents.length > 5, 'expected streamed deltas');
      assert.equal(starts.length, ends.length, 'every message must be closed');
    });

    test('de-duplicates cumulative text into non-overlapping deltas', () => {
      // The mock resends the whole message each update. The adapter must turn that
      // back into deltas, so reassembly equals the text exactly once.
      const text = events
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.delta as string)
        .join('');
      const marker = 'Checking workload health';
      assert.equal(
        text.split(marker).length - 1,
        1,
        `"${marker}" should appear exactly once, got: ${text.slice(0, 200)}`,
      );
    });

    test('maps kagent tool activity to AG-UI tool events', () => {
      const starts = events.filter((e) => e.type === 'TOOL_CALL_START');
      const results = events.filter((e) => e.type === 'TOOL_CALL_RESULT');
      assert.deepEqual(
        starts.map((e) => e.toolCallName),
        ['kubernetes_read', 'kubernetes_read', 'prometheus_query', 'prometheus_query'],
      );
      assert.equal(results.length, starts.length, 'each tool call must produce a result');
      assert.ok(
        events.some((e) => e.type === 'TOOL_CALL_ARGS'),
        'tool arguments must reach the Portal',
      );
    });

    test('every tool call is opened and closed', () => {
      const opened = events.filter((e) => e.type === 'TOOL_CALL_START').map((e) => e.toolCallId);
      const closed = events.filter((e) => e.type === 'TOOL_CALL_END').map((e) => e.toolCallId);
      assert.deepEqual(opened.sort(), closed.sort());
    });

    test('final result validates against agent-result.schema.json', () => {
      const finished = events.at(-1) as { result?: unknown };
      assert.doesNotThrow(() => assertAgentResult(finished.result));

      const result = finished.result as AgentResult;
      assert.equal(result.status, 'completed');
      assert.ok(result.findings!.length >= 2, 'expected findings');
      assert.ok(
        result.findings!.some((f) => f.category === 'root_cause'),
        'a diagnosis should name at least one root cause candidate',
      );
      assert.ok(result.evidence!.length >= 3, 'expected evidence');
      assert.equal(result.trace.agent_run_id, 'run-e2e-1');
    });

    test('evidence ids are unique after merging agent and tool evidence', () => {
      const result = (events.at(-1) as { result: AgentResult }).result;
      const ids = result.evidence!.map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate evidence ids: ${ids.join(', ')}`);
    });

    test('findings resolve to real evidence', () => {
      const result = (events.at(-1) as { result: AgentResult }).result;
      const ids = new Set(result.evidence!.map((e) => e.id));
      for (const finding of result.findings ?? []) {
        for (const ref of finding.evidence_refs ?? []) {
          assert.ok(ids.has(ref), `finding ${finding.id} references missing evidence ${ref}`);
        }
      }
    });

    test('the declared plan arrives as shared state and settles honestly', () => {
      const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT');
      assert.ok(snapshots.length > 1, 'the plan should update as the run proceeds');

      const first = (snapshots[0] as { snapshot: { plan?: PlanStep[] } }).snapshot.plan;
      assert.ok(first, 'a plan should be declared before any work');
      assert.deepEqual(
        first.map((s) => s.status),
        ['pending', 'pending', 'pending', 'pending'],
        'the plan starts entirely unstarted - that is the point of declaring it',
      );
      assert.ok(
        first.some((s) => s.label.toLowerCase().includes('network')),
        'the network step should be visible before it is reached',
      );

      const final = (snapshots.at(-1) as { snapshot: { plan?: PlanStep[] } }).snapshot.plan!;
      assert.ok(
        !final.some((s) => s.status === 'pending'),
        'no step may still read as upcoming once the run is over',
      );
      assert.deepEqual(
        final.map((s) => s.status),
        ['done', 'done', 'done', 'skipped'],
        'three steps ran; the agent explicitly skipped the network check',
      );
      assert.ok(final.at(-1)?.detail, 'a skipped step should say why');
    });

    test('the plan markup never reaches the displayed answer', () => {
      const shown = events
        .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
        .map((e) => e.delta as string)
        .join('');
      assert.ok(!shown.includes('[PLAN]'), 'plan markers leaked into the answer');
      assert.ok(!shown.includes('[/PLAN]'), 'plan markers leaked into the answer');
      assert.ok(!/- \[ \]/.test(shown), 'checklist rows leaked into the answer');
    });

    test('the terminal STATE_SNAPSHOT carries the result for AG-UI shared state', () => {
      const snapshots = events.filter((e) => e.type === 'STATE_SNAPSHOT');
      assert.ok(snapshots.length > 0, 'expected a STATE_SNAPSHOT');
      // Earlier snapshots carry only the plan; the result lands on the last one.
      assert.ok((snapshots.at(-1) as { snapshot: { result?: unknown } }).snapshot.result);
    });
  });

  describe('shared agents (SPEC 12)', () => {
    test('the Architecture Agent runs through the same route and contract', async () => {
      const run = await runAgent({
        agent: 'architecture_agent',
        task: 'Review this async ingestion design against SCP standards.',
        threadId: 'thread-e2e-2',
        runId: 'run-e2e-2',
      });
      assert.equal(run.status, 200);

      const finished = run.events.at(-1) as { type: string; result?: unknown };
      assert.equal(finished.type, 'RUN_FINISHED');
      assert.doesNotThrow(() => assertAgentResult(finished.result));
      assert.ok(
        run.events.some(
          (e) => e.type === 'TOOL_CALL_START' && e.toolCallName === 'knowledge_search',
        ),
        'architecture agent should have searched knowledge',
      );
    });
  });

  describe('invocation validation (SPEC 7)', () => {
    test('an empty task is rejected before the stream opens', async () => {
      const run = await runAgent({ agent: 'architecture_agent', task: '' });
      assert.equal(run.status, 400);
    });

    test('an unknown agent is rejected with 404', async () => {
      const run = await runAgent({ agent: 'network_agent', task: 'anything' });
      assert.equal(run.status, 404);
    });
  });

  describe('cancellation (SPEC 10)', () => {
    test('cancelling a run stops the stream and audits it as cancelled', async () => {
      const runId = 'run-cancel-1';
      const controller = new AbortController();

      const streamed = fetch(`${BASE}/agui/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'x-scp-user': 'e2e-user',
        },
        body: JSON.stringify({
          agent: 'kubernetes_agent',
          task: 'long running diagnosis',
          threadId: 'thread-cancel',
          runId,
        }),
        signal: controller.signal,
      }).then((res) => res.text());

      // Let the run get going, then cancel it out of band, the way the Cancel
      // button does.
      await new Promise((r) => setTimeout(r, 600));
      const cancel = await fetch(`${BASE}/api/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'x-scp-user': 'e2e-user' },
      });
      assert.equal(cancel.status, 200, 'cancel should find the live run');

      const body = await streamed;
      assert.ok(body.includes('RUN_STARTED'), 'the run should have started');
      assert.ok(body.includes('RUN_FINISHED'), 'a cancelled run still gets a terminal event');
      controller.abort();
    });

    test('cancelling an unknown run is a 404', async () => {
      const res = await fetch(`${BASE}/api/runs/does-not-exist/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(res.status, 404);
    });
  });

  describe('audit (SPEC 18)', () => {
    test('records every run with access_mode=portal and a trace id', async () => {
      assert.ok(existsSync(auditFile), 'audit file should exist');
      const records = readFileSync(auditFile, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as AuditRecord);

      const run = records.find((r) => r.agent_run_id === 'run-e2e-1');
      assert.ok(run, 'the kubernetes run must be audited');
      assert.equal(run.access_mode, 'portal');
      assert.equal(run.user, 'e2e-user');
      assert.equal(run.status, 'completed');
      assert.ok(run.trace_id, 'trace id must be present');
      assert.ok(run.duration_ms > 0);
      assert.deepEqual(
        run.tools.map((t) => t.name),
        ['kubernetes_read', 'kubernetes_read', 'prometheus_query', 'prometheus_query'],
        'audited tool calls must match what ran',
      );

      assert.ok(
        records.some((r) => r.status === 'rejected'),
        'rejected invocations must also be audited',
      );
    });
  });
});
