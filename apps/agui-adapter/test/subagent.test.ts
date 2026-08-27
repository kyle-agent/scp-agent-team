import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '@scp/agent-registry';
import type { AgentInvocation } from '@scp/contracts';
import { A2AToAguiMapper } from '../src/kagent/map-to-agui.ts';
import { authorOf, delegationFromPart, delegationFromTool } from '../src/kagent/subagent.ts';
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

function parts(list: unknown[], messageId = 'm1'): A2AStreamResult {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'ctx-1',
    status: {
      state: 'working' as never,
      message: { kind: 'message', role: 'agent', messageId, parts: list as never },
    },
  };
}

function transfer(agent: string, id = 'c1') {
  return parts([
    {
      kind: 'data',
      data: { kind: 'tool-call', tool_call_id: id, name: 'transfer_to_agent', args: { agent_name: agent, task: 'look at the network' } },
    },
  ]);
}

function transferBack(id = 'c1') {
  return parts([
    {
      kind: 'data',
      data: { kind: 'tool-result', tool_call_id: id, name: 'transfer_to_agent', result: { verdict: 'ok' } },
    },
  ]);
}

describe('delegation detection', () => {
  test('a transfer tool names the agent it hands off to', () => {
    const signal = delegationFromTool(
      { phase: 'call', toolCallId: 'c1', name: 'transfer_to_agent', args: { agent_name: 'network_agent' } },
      new Set(),
    );
    assert.deepEqual(signal, { phase: 'start', name: 'network_agent', parentToolCallId: 'c1' });
  });

  test('a transfer with no named target stays an ordinary tool call', () => {
    // Inventing an agent name would be worse than showing the raw tool.
    assert.equal(
      delegationFromTool({ phase: 'call', toolCallId: 'c1', name: 'transfer_to_agent', args: {} }, new Set()),
      undefined,
    );
  });

  test('a tool named after a shared agent is a delegation', () => {
    const signal = delegationFromTool(
      { phase: 'call', toolCallId: 'c2', name: 'kubernetes_agent', args: {} },
      new Set(['kubernetes_agent']),
    );
    assert.equal(signal?.phase === 'start' && signal.name, 'kubernetes_agent');
  });

  test('an ordinary tool is not a delegation', () => {
    assert.equal(
      delegationFromTool({ phase: 'call', toolCallId: 'c3', name: 'prometheus_query', args: {} }, new Set(['kubernetes_agent'])),
      undefined,
    );
  });

  test('an explicit delegation data part is recognised', () => {
    assert.deepEqual(
      delegationFromPart({ kind: 'data', data: { kind: 'agent-call', agent: 'storage_agent', task: 'check volumes' } }),
      { phase: 'start', name: 'storage_agent', description: 'check volumes' },
    );
  });

  test('message metadata names the author', () => {
    assert.equal(
      authorOf({ role: 'agent', messageId: 'm', parts: [], metadata: { author: 'network_agent' } }),
      'network_agent',
    );
    assert.equal(authorOf({ role: 'agent', messageId: 'm', parts: [] }), undefined);
  });
});

describe('collaboration in the event stream', () => {
  test('a delegation becomes SUBAGENT_STARTED, not a tool row', () => {
    const events = drain(newMapper(), [transfer('network_agent')]);
    assert.deepEqual(events.map((e) => e.type), ['SUBAGENT_STARTED']);
    const started = events[0] as { name: string; parentToolCallId?: string };
    assert.equal(started.name, 'network_agent');
    assert.equal(started.parentToolCallId, 'c1');
    assert.ok(
      !events.some((e) => e.type === 'TOOL_CALL_START'),
      'a handoff must not read as a tool call',
    );
  });

  test("the sub-agent's work is attributed to it", () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      transfer('network_agent'),
      parts([{ kind: 'text', text: 'Tracing the path.' }], 'm2'),
      parts([{ kind: 'data', data: { kind: 'tool-call', tool_call_id: 't1', name: 'prometheus_query', args: {} } }]),
    ]);

    const subRunId = (events[0] as { subagentRunId: string }).subagentRunId;
    const attributed = events.filter((e) => e.subagentRunId === subRunId).map((e) => e.type);
    assert.ok(attributed.includes('TEXT_MESSAGE_CONTENT'), 'its text should be attributed');
    assert.ok(attributed.includes('TOOL_CALL_START'), 'its tool calls should be attributed');
  });

  test('control returns to the caller when the transfer result arrives', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      transfer('network_agent'),
      transferBack(),
      parts([{ kind: 'text', text: 'Back to me.' }], 'm3'),
    ]);

    const finished = events.find((e) => e.type === 'SUBAGENT_FINISHED');
    assert.ok(finished, 'expected SUBAGENT_FINISHED');
    const after = events.slice(events.indexOf(finished!) + 1);
    assert.ok(
      after.every((e) => e.subagentRunId === undefined),
      'work after the handoff belongs to the caller again',
    );
  });

  test('nested delegation unwinds in the right order', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      transfer('network_agent', 'outer'),
      transfer('storage_agent', 'inner'),
      transferBack('inner'),
      transferBack('outer'),
    ]);

    const order = events
      .filter((e) => e.type === 'SUBAGENT_STARTED' || e.type === 'SUBAGENT_FINISHED')
      .map((e) => `${e.type}:${(e as { subagentRunId: string }).subagentRunId}`);
    assert.deepEqual(order, [
      'SUBAGENT_STARTED:run-1-sub-1',
      'SUBAGENT_STARTED:run-1-sub-2',
      'SUBAGENT_FINISHED:run-1-sub-2',
      'SUBAGENT_FINISHED:run-1-sub-1',
    ]);
  });

  test('an out-of-order end closes the inner agents too, never strands them', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      transfer('network_agent', 'outer'),
      transfer('storage_agent', 'inner'),
      transferBack('outer'),
    ]);
    const finished = events.filter((e) => e.type === 'SUBAGENT_FINISHED');
    assert.equal(finished.length, 2, 'closing the outer agent must close the inner one');
  });

  test('a run never ends with an agent still holding the floor', () => {
    const mapper = newMapper();
    drain(mapper, [transfer('network_agent')]);
    const tail = [...mapper.finish()];
    assert.ok(
      tail.some((e) => e.type === 'SUBAGENT_FINISHED'),
      'finish() must hand the floor back',
    );
    const runFinished = tail.at(-1);
    assert.equal(runFinished?.type, 'RUN_FINISHED');
    assert.equal(runFinished?.subagentRunId, undefined, 'the run belongs to no single participant');
  });

  test('author metadata switches participant without a visible tool call', () => {
    const mapper = newMapper();
    const events = drain(mapper, [
      {
        kind: 'status-update',
        taskId: 't',
        contextId: 'c',
        status: {
          state: 'working' as never,
          message: {
            kind: 'message',
            role: 'agent',
            messageId: 'm1',
            metadata: { author: 'network_agent' },
            parts: [{ kind: 'text', text: 'Checking routes.' }] as never,
          },
        },
      },
    ]);
    assert.equal(events[0]?.type, 'SUBAGENT_STARTED');
    assert.equal((events[0] as { name: string }).name, 'network_agent');
  });

  test('the author returning to the root agent hands the floor back', () => {
    const mapper = newMapper();
    const authored = (author: string, id: string): A2AStreamResult => ({
      kind: 'status-update',
      taskId: 't',
      contextId: 'c',
      status: {
        state: 'working' as never,
        message: {
          kind: 'message',
          role: 'agent',
          messageId: id,
          metadata: { author },
          parts: [{ kind: 'text', text: 'x' }] as never,
        },
      },
    });
    const events = drain(mapper, [authored('network_agent', 'm1'), authored('k8s-agent', 'm2')]);
    assert.ok(events.some((e) => e.type === 'SUBAGENT_FINISHED'));
  });

  test('participants are recorded for audit', () => {
    const mapper = newMapper();
    drain(mapper, [transfer('network_agent', 'a'), transferBack('a'), transfer('storage_agent', 'b')]);
    assert.deepEqual(mapper.participants, ['network_agent', 'storage_agent']);
  });

  test("a sub-agent's tool calls are still subject to the read-only policy", () => {
    const mapper = newMapper();
    drain(mapper, [transfer('network_agent')]);
    assert.throws(
      () =>
        drain(mapper, [
          parts([{ kind: 'data', data: { kind: 'tool-call', tool_call_id: 'x', name: 'delete', args: {} } }]),
        ]),
      /blocked|write operation/,
      'delegating must not be a way around the tool policy',
    );
  });

  test('a single-agent run carries no attribution at all', () => {
    const mapper = newMapper();
    const events = drain(mapper, [parts([{ kind: 'text', text: 'Just me.' }])]);
    assert.ok(events.every((e) => e.subagentRunId === undefined));
    assert.deepEqual(mapper.participants, []);
  });
});

describe('message identity across a handoff', () => {
  test('reopening the same A2A message gets a fresh AG-UI id', () => {
    const mapper = newMapper();
    // kagent can stream a whole run under one messageId. A delegation closes
    // that message; the caller's next line must not restart an ended message.
    const events = drain(mapper, [
      parts([{ kind: 'text', text: 'Before. ' }], 'same'),
      transfer('network_agent'),
      transferBack(),
      parts([{ kind: 'text', text: 'Before. After.' }], 'same'),
    ]);
    events.push(...mapper.finish());

    const ids = events
      .filter((e) => e.type === 'TEXT_MESSAGE_START')
      .map((e) => (e as { messageId: string }).messageId);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, `ids collided: ${ids.join(', ')}`);

    // Every started message is also ended, exactly once.
    const ended = events
      .filter((e) => e.type === 'TEXT_MESSAGE_END')
      .map((e) => (e as { messageId: string }).messageId);
    assert.deepEqual(ended.sort(), ids.sort());
  });

  test('a run that fails mid-delegation reports the error on that agent', () => {
    const mapper = newMapper();
    drain(mapper, [transfer('network_agent')]);
    mapper.markFailed('kagent stream broke');
    const tail = [...mapper.finish()];

    const errored = tail.find((e) => e.type === 'SUBAGENT_ERROR');
    assert.ok(errored, 'the specialist holding the floor should be marked failed');
    assert.equal((errored as { message: string }).message, 'kagent stream broke');
    assert.ok(
      !tail.some((e) => e.type === 'SUBAGENT_FINISHED'),
      'a failed handoff must not report as a clean hand-back',
    );
  });
});
