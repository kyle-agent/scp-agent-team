import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initialRunState, type RunState } from '../src/lib/run-state.ts';
import type { AguiEvent } from '../src/lib/agui-events.ts';

function reduce(events: AguiEvent[], from: RunState = initialRunState): RunState {
  return events.reduce(applyEvent, from);
}

const started: AguiEvent = { type: 'RUN_STARTED', threadId: 't', runId: 'r' };

describe('run state reducer', () => {
  test('a run resets any previous state', () => {
    const stale = reduce([started, { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }]);
    const fresh = applyEvent(stale, { type: 'RUN_STARTED', threadId: 't2', runId: 'r2' });
    assert.equal(fresh.timeline.length, 0);
    assert.equal(fresh.answer, '');
    assert.equal(fresh.runId, 'r2');
    assert.equal(fresh.phase, 'running');
  });

  test('text deltas accumulate into one timeline entry', () => {
    const state = reduce([
      started,
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hello ' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'world' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    ]);
    assert.equal(state.timeline.length, 1);
    const item = state.timeline[0]!;
    assert.equal(item.kind, 'message');
    assert.equal(item.kind === 'message' && item.text, 'Hello world');
    assert.equal(item.kind === 'message' && item.status, 'done');
    assert.equal(state.answer, 'Hello world');
  });

  test('a tool stays running until its result arrives', () => {
    const afterEnd = reduce([
      started,
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'kubernetes_read' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"verb":"list"}' },
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
    ]);
    const tool = afterEnd.timeline[0]!;
    assert.equal(tool.kind === 'tool' && tool.status, 'running');

    const afterResult = applyEvent(afterEnd, {
      type: 'TOOL_CALL_RESULT',
      messageId: 'x',
      toolCallId: 'c1',
      content: '{"pods":3}',
    });
    const done = afterResult.timeline[0]!;
    assert.equal(done.kind === 'tool' && done.status, 'done');
    assert.equal(done.kind === 'tool' && done.result, '{"pods":3}');
  });

  test('an event for an unknown id does not create a phantom entry', () => {
    const state = reduce([started, { type: 'TOOL_CALL_ARGS', toolCallId: 'ghost', delta: 'x' }]);
    assert.equal(state.timeline.length, 0);
  });

  test('RUN_FINISHED does not overwrite an earlier RUN_ERROR', () => {
    const state = reduce([
      started,
      { type: 'RUN_ERROR', message: 'kagent unreachable', code: 'KAGENT_UNREACHABLE' },
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        result: { status: 'completed', summary: 'x', trace: { trace_id: 't', agent_run_id: 'r' } },
      },
    ]);
    assert.equal(state.phase, 'failed');
    assert.equal(state.error, 'kagent unreachable');
  });

  test('a cancelled result surfaces as cancelled', () => {
    const state = reduce([
      started,
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        result: { status: 'cancelled', summary: '', trace: { trace_id: 't', agent_run_id: 'r' } },
      },
    ]);
    assert.equal(state.phase, 'cancelled');
  });

  test('CUSTOM events become renderable blocks (the A2UI seam)', () => {
    const state = reduce([started, { type: 'CUSTOM', name: 'a2ui', value: { root: 'Card' } }]);
    const item = state.timeline[0]!;
    assert.equal(item.kind, 'custom');
    assert.equal(item.kind === 'custom' && item.name, 'a2ui');
  });

  test('steps open and close', () => {
    const state = reduce([
      started,
      { type: 'STEP_STARTED', stepName: 'Kubernetes Agent' },
      { type: 'STEP_FINISHED', stepName: 'Kubernetes Agent' },
    ]);
    assert.equal(state.timeline.length, 1);
    assert.equal(state.timeline[0]!.kind === 'step' && state.timeline[0]!.status, 'done');
  });
});

describe('plan in shared state', () => {
  const plan = [
    { id: 'a', label: 'Check pods', status: 'running' as const },
    { id: 'b', label: 'Check network', status: 'pending' as const },
  ];

  test('a snapshot carrying only a plan does not clear the result', () => {
    const withResult = reduce([
      started,
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { result: { status: 'completed', summary: 's', trace: { trace_id: 't', agent_run_id: 'r' } } },
      },
    ]);
    const withPlan = applyEvent(withResult, { type: 'STATE_SNAPSHOT', snapshot: { plan } });
    assert.equal(withPlan.plan?.length, 2);
    assert.equal(withPlan.result?.summary, 's', 'the result must survive a plan-only snapshot');
  });

  test('a later snapshot replaces the plan wholesale', () => {
    const state = reduce([
      started,
      { type: 'STATE_SNAPSHOT', snapshot: { plan } },
      {
        type: 'STATE_SNAPSHOT',
        snapshot: { plan: [{ id: 'a', label: 'Check pods', status: 'done' }, { id: 'b', label: 'Check network', status: 'skipped' }] },
      },
    ]);
    assert.deepEqual(state.plan?.map((s) => s.status), ['done', 'skipped']);
  });

  test('a new run clears the previous plan', () => {
    const state = reduce([started, { type: 'STATE_SNAPSHOT', snapshot: { plan } }]);
    const next = applyEvent(state, { type: 'RUN_STARTED', threadId: 't', runId: 'r2' });
    assert.equal(next.plan, undefined);
  });
});
