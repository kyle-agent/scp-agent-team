import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@scp/agent-registry';
import type { AgentInvocation, PlanStep } from '@scp/contracts';
import { A2AToAguiMapper } from '../src/kagent/map-to-agui.ts';
import { inputRequestFromMessage, inputRequestFromPart } from '../src/kagent/input-request.ts';
import type { A2AStreamResult } from '../src/kagent/a2a.ts';
import type { AguiEvent } from '../src/agui/events.ts';

const registry = AgentRegistry.fromDirectory(new URL('../../../agents/', import.meta.url).pathname);

const invocation: AgentInvocation = {
  request_id: 'req-1',
  agent: 'kubernetes_agent',
  task: 'roll back?',
  actor: { type: 'portal', user_id: 'u1' },
  correlation: { trace_id: 'trace-1' },
};

function newMapper(resumePlan?: PlanStep[]) {
  return new A2AToAguiMapper({
    invocation,
    card: registry.require('kubernetes_agent'),
    registry,
    threadId: 'thread-1',
    runId: 'run-1',
    ...(resumePlan ? { resumePlan } : {}),
  });
}

function drain(mapper: A2AToAguiMapper, results: A2AStreamResult[]): AguiEvent[] {
  const events: AguiEvent[] = [];
  for (const result of results) events.push(...mapper.map(result));
  return events;
}

function status(state: string, parts: unknown[]): A2AStreamResult {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'ctx-1',
    status: {
      state: state as never,
      message: { kind: 'message', role: 'agent', messageId: 'm1', parts: parts as never },
    },
  };
}

const ASK = {
  kind: 'data',
  data: {
    kind: 'input-request',
    prompt: 'Which release should I assess?',
    options: [
      { value: '1.41.3', label: 'checkout:1.41.3', detail: 'last known good' },
      { value: '1.41.9', label: 'checkout:1.41.9' },
    ],
  },
};

describe('input request detection', () => {
  test('reads a structured request with options', () => {
    const request = inputRequestFromPart(ASK);
    assert.equal(request?.prompt, 'Which release should I assess?');
    assert.deepEqual(request?.options?.map((o) => o.value), ['1.41.3', '1.41.9']);
  });

  test('accepts plain-string options', () => {
    const request = inputRequestFromPart({
      kind: 'data',
      data: { kind: 'ask_user', prompt: 'Which namespace?', options: ['checkout', 'checkout-canary'] },
    });
    assert.deepEqual(request?.options?.map((o) => o.label), ['checkout', 'checkout-canary']);
  });

  test('falls back to the prose the agent paused on', () => {
    const request = inputRequestFromMessage({
      role: 'agent',
      messageId: 'm',
      parts: [{ kind: 'text', text: 'Which namespace should I check?' }],
    });
    assert.deepEqual(request, { prompt: 'Which namespace should I check?' });
  });

  test('a request with no question is not a request', () => {
    assert.equal(inputRequestFromPart({ kind: 'data', data: { kind: 'input-request' } }), undefined);
    assert.equal(inputRequestFromMessage(undefined), undefined);
    assert.equal(inputRequestFromMessage({ role: 'agent', messageId: 'm', parts: [] }), undefined);
  });

  test('an unrelated data part is not a request', () => {
    assert.equal(
      inputRequestFromPart({ kind: 'data', data: { kind: 'tool-call', name: 'x' } }),
      undefined,
    );
  });
});

describe('pausing a run', () => {
  test('input-required parks the run and carries the question in shared state', () => {
    const mapper = newMapper();
    drain(mapper, [status('input-required', [ASK])]);
    const tail = [...mapper.finish()];

    const snapshot = tail.find((e) => e.type === 'STATE_SNAPSHOT') as {
      snapshot: { pendingInput?: { prompt: string } };
    };
    assert.equal(snapshot.snapshot.pendingInput?.prompt, 'Which release should I assess?');

    const finished = tail.at(-1) as { result: { status: string; summary: string } };
    assert.equal(finished.result.status, 'needs_input');
    assert.equal(
      finished.result.summary,
      'Which release should I assess?',
      'the summary should be the question, not whatever was said before it',
    );
  });

  test('the question is not also streamed as ordinary answer text', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      status('input-required', [{ kind: 'text', text: 'Which namespace should I check?' }]),
    ]);
    assert.ok(
      !events.some((e) => e.type === 'TEXT_MESSAGE_CONTENT'),
      'the prompt belongs in the ask panel, not in the transcript',
    );
    assert.equal(mapper.pendingInput?.prompt, 'Which namespace should I check?');
  });

  test('a paused plan keeps its remaining steps pending, not skipped', () => {
    const mapper = newMapper([
      { id: 'a', label: 'Find candidates', status: 'done' },
      { id: 'b', label: 'Confirm with operator', status: 'pending' },
      { id: 'c', label: 'Assess', status: 'pending' },
    ]);
    drain(mapper, [status('input-required', [ASK])]);
    const tail = [...mapper.finish()];
    const snapshot = tail.find((e) => e.type === 'STATE_SNAPSHOT') as {
      snapshot: { plan?: PlanStep[] };
    };
    assert.deepEqual(
      snapshot.snapshot.plan?.map((s) => s.status),
      ['done', 'pending', 'pending'],
      'a paused run is not over, so its steps are still to come',
    );
  });

  test('a run that is not paused reports no pending input', () => {
    const mapper = newMapper();
    drain(mapper, [status('working', [{ kind: 'text', text: 'fine' }])]);
    const tail = [...mapper.finish()];
    const snapshot = tail.find((e) => e.type === 'STATE_SNAPSHOT') as {
      snapshot: { pendingInput?: unknown };
    };
    assert.equal(snapshot.snapshot.pendingInput, undefined);
    assert.equal(mapper.pendingInput, undefined);
  });
});

describe('resuming a run', () => {
  test('progress made before the pause survives', () => {
    const mapper = newMapper([
      { id: 'a', label: 'Find candidates', status: 'done', tool: 'kubernetes_read' },
      { id: 'b', label: 'Assess', status: 'pending', tool: 'prometheus_query' },
    ]);
    const events = drain(mapper, [
      status('working', [
        { kind: 'data', data: { kind: 'tool-call', tool_call_id: 'c1', name: 'prometheus_query', args: {} } },
      ]),
    ]);
    const snapshot = events.filter((e) => e.type === 'STATE_SNAPSHOT').at(-1) as {
      snapshot: { plan?: PlanStep[] };
    };
    assert.deepEqual(snapshot.snapshot.plan?.map((s) => s.status), ['done', 'running']);
  });

  test('a replayed plan declaration does not wipe that progress', () => {
    const mapper = newMapper([
      { id: 'a', label: 'Find candidates', status: 'done' },
      { id: 'b', label: 'Assess', status: 'pending' },
    ]);
    // A resumed task may resend the text it already streamed, plan block and all.
    const events = drain(mapper, [
      status('working', [
        { kind: 'text', text: '[PLAN]\n- [ ] Find candidates\n- [ ] Assess\n[/PLAN]\n' },
      ]),
    ]);
    const snapshot = events.filter((e) => e.type === 'STATE_SNAPSHOT').at(-1) as {
      snapshot: { plan?: PlanStep[] };
    };
    assert.deepEqual(
      snapshot.snapshot.plan?.map((s) => s.status),
      ['done', 'pending'],
      'the same plan re-declared must keep the statuses it already had',
    );
  });

  test('a genuinely different plan replaces the old one', () => {
    const mapper = newMapper([{ id: 'a', label: 'Old step', status: 'done' }]);
    const events = drain(mapper, [
      status('working', [{ kind: 'text', text: '[PLAN]\n- [ ] Something else\n[/PLAN]\n' }]),
    ]);
    const snapshot = events.filter((e) => e.type === 'STATE_SNAPSHOT').at(-1) as {
      snapshot: { plan?: PlanStep[] };
    };
    assert.deepEqual(snapshot.snapshot.plan?.map((s) => [s.label, s.status]), [
      ['Something else', 'pending'],
    ]);
  });

  test('the resumed plan is exposed for parking', () => {
    const mapper = newMapper([{ id: 'a', label: 'Step', status: 'done' }]);
    assert.deepEqual(mapper.currentPlan, [{ id: 'a', label: 'Step', status: 'done' }]);
    // A copy, so a caller cannot mutate the mapper's state by accident.
    mapper.currentPlan![0]!.status = 'failed';
    assert.equal(mapper.currentPlan![0]!.status, 'done');
  });
});
