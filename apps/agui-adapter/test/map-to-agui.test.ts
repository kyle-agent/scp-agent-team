import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@scp/agent-registry';
import type { AgentInvocation } from '@scp/contracts';
import { A2AToAguiMapper } from '../src/kagent/map-to-agui.ts';
import { detectToolSignal } from '../src/kagent/tool-signal.ts';
import type { A2AStreamResult } from '../src/kagent/a2a.ts';
import type { AguiEvent } from '../src/agui/events.ts';

const registry = AgentRegistry.fromDirectory(new URL('../../../agents/', import.meta.url).pathname);

const invocation: AgentInvocation = {
  request_id: 'req-1',
  agent: 'kubernetes_agent',
  task: 'diagnose',
  actor: { type: 'portal', user_id: 'u1' },
  correlation: { trace_id: 'trace-1' },
};

function newMapper() {
  return new A2AToAguiMapper({
    invocation,
    card: registry.require('kubernetes_agent'),
    registry,
    threadId: 'thread-1',
    runId: 'run-1',
  });
}

function drain(mapper: A2AToAguiMapper, results: A2AStreamResult[]): AguiEvent[] {
  const events: AguiEvent[] = [];
  for (const result of results) events.push(...mapper.map(result));
  return events;
}

function statusUpdate(parts: unknown[], state = 'working'): A2AStreamResult {
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

describe('text mapping', () => {
  test('cumulative resends become non-overlapping deltas', () => {
    const events = drain(newMapper(), [
      statusUpdate([{ kind: 'text', text: 'Checking ' }]),
      statusUpdate([{ kind: 'text', text: 'Checking workload ' }]),
      statusUpdate([{ kind: 'text', text: 'Checking workload health.' }]),
    ]);

    const deltas = events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => (e as { delta: string }).delta);
    assert.deepEqual(deltas, ['Checking ', 'workload ', 'health.']);
    assert.equal(deltas.join(''), 'Checking workload health.');
    assert.equal(events.filter((e) => e.type === 'TEXT_MESSAGE_START').length, 1);
  });

  test('true deltas pass through unchanged', () => {
    const events = drain(newMapper(), [
      statusUpdate([{ kind: 'text', text: 'alpha ' }]),
      statusUpdate([{ kind: 'text', text: 'beta' }]),
    ]);
    const deltas = events
      .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
      .map((e) => (e as { delta: string }).delta);
    assert.deepEqual(deltas, ['alpha ', 'beta']);
  });

  test('a new messageId closes the previous message', () => {
    const mapper = newMapper();
    const events = [
      ...drain(mapper, [statusUpdate([{ kind: 'text', text: 'first' }])]),
      ...mapper.map({
        kind: 'status-update',
        taskId: 't',
        contextId: 'c',
        status: {
          state: 'working' as never,
          message: { kind: 'message', role: 'agent', messageId: 'm2', parts: [{ kind: 'text', text: 'second' }] as never },
        },
      }),
      ...mapper.finish(),
    ];
    const ends = events.filter((e) => e.type === 'TEXT_MESSAGE_END');
    assert.deepEqual(ends.map((e) => (e as { messageId: string }).messageId), ['m1', 'm2']);
  });
});

describe('tool mapping', () => {
  test('a read tool becomes START/ARGS/END then RESULT', () => {
    const events = drain(newMapper(), [
      statusUpdate([
        { kind: 'data', data: { kind: 'tool-call', tool_call_id: 'c1', name: 'kubernetes_read', args: { verb: 'list' } } },
      ]),
      statusUpdate([
        { kind: 'data', data: { kind: 'tool-result', tool_call_id: 'c1', name: 'kubernetes_read', result: { pods: 3 } } },
      ]),
    ]);
    assert.deepEqual(events.map((e) => e.type), [
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
    ]);
  });

  test('a write tool aborts the run rather than being relayed (SPEC 14)', () => {
    const mapper = newMapper();
    assert.throws(
      () =>
        drain(mapper, [
          statusUpdate([
            { kind: 'data', data: { kind: 'tool-call', tool_call_id: 'c9', name: 'delete', args: {} } },
          ]),
        ]),
      /blocked|write operation/,
    );
  });

  test('tool results become evidence', () => {
    const mapper = newMapper();
    drain(mapper, [
      statusUpdate([{ kind: 'data', data: { kind: 'tool-call', tool_call_id: 'c1', name: 'prometheus_query', args: {} } }]),
      statusUpdate([{ kind: 'data', data: { kind: 'tool-result', tool_call_id: 'c1', result: { value: 2.4 } } }]),
    ]);
    const result = mapper.buildResult();
    assert.equal(result.evidence?.length, 1);
    assert.equal(result.evidence?.[0]?.source, 'prometheus_query');
  });

  test('unrecognised data parts surface as CUSTOM instead of being dropped', () => {
    const events = drain(newMapper(), [
      statusUpdate([{ kind: 'data', data: { something: 'unmodelled' } }]),
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'CUSTOM');
    assert.equal((events[0] as { name: string }).name, 'a2a.data_part');
  });
});

describe('tool signal detection', () => {
  test('recognises the ADK functionCall shape', () => {
    const signal = detectToolSignal({
      kind: 'data',
      data: { functionCall: { id: 'f1', name: 'get_pod', args: { name: 'p' } } },
    });
    assert.deepEqual(signal, { phase: 'call', toolCallId: 'f1', name: 'get_pod', args: { name: 'p' } });
  });

  test('recognises the ADK functionResponse shape', () => {
    const signal = detectToolSignal({
      kind: 'data',
      data: { functionResponse: { id: 'f1', name: 'get_pod', response: { ok: true } } },
    });
    assert.equal(signal?.phase, 'result');
    assert.equal(signal?.toolCallId, 'f1');
  });

  test('ignores text parts and unrelated data', () => {
    assert.equal(detectToolSignal({ kind: 'text', text: 'hello' }), undefined);
    assert.equal(detectToolSignal({ kind: 'data', data: { chart: [1, 2] } }), undefined);
  });
});

describe('result assembly', () => {
  test('adopts an agent-supplied AgentResult and stamps the trace', () => {
    const mapper = newMapper();
    drain(mapper, [
      {
        kind: 'artifact-update',
        taskId: 't',
        contextId: 'c',
        artifact: {
          artifactId: 'a1',
          name: 'agent-result',
          parts: [
            {
              kind: 'data',
              data: {
                status: 'completed',
                summary: 'structured',
                findings: [{ id: 'f1', title: 'x', severity: 'high' }],
              },
            } as never,
          ],
        },
      },
    ]);
    const result = mapper.buildResult();
    assert.equal(result.summary, 'structured');
    assert.equal(result.findings?.length, 1);
    assert.equal(result.trace.trace_id, 'trace-1');
    assert.equal(result.trace.agent_run_id, 'run-1');
  });

  test('rejects a malformed structured result and falls back to prose', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      statusUpdate([{ kind: 'text', text: 'prose answer' }]),
      {
        kind: 'artifact-update',
        taskId: 't',
        contextId: 'c',
        artifact: {
          artifactId: 'a1',
          name: 'agent-result',
          // `status: "weird"` is not in the enum, so this must not be adopted.
          parts: [{ kind: 'data', data: { status: 'weird', summary: 'nope' } } as never],
        },
      },
    ]);
    const result = mapper.buildResult();
    assert.equal(result.summary, 'prose answer');
    assert.ok(events.some((e) => e.type === 'CUSTOM'), 'the rejected payload should still be surfaced');
  });

  test('a failed task state maps to a failed result', () => {
    const mapper = newMapper();
    drain(mapper, [statusUpdate([{ kind: 'text', text: 'x' }], 'failed')]);
    assert.equal(mapper.buildResult().status, 'failed');
  });

  test('finish() closes messages and emits terminal events', () => {
    const mapper = newMapper();
    drain(mapper, [statusUpdate([{ kind: 'text', text: 'partial' }])]);
    const tail = [...mapper.finish()].map((e) => e.type);
    assert.deepEqual(tail, ['TEXT_MESSAGE_END', 'STEP_FINISHED', 'STATE_SNAPSHOT', 'RUN_FINISHED']);
  });
});
