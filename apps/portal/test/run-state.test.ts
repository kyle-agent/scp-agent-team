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

describe('multi-agent collaboration', () => {
  const sub: AguiEvent = {
    type: 'SUBAGENT_STARTED',
    subagentRunId: 'sub-1',
    name: 'network_agent',
    description: 'check the path',
  };

  test("a delegated agent's work is nested under the delegation", () => {
    const state = reduce([
      started,
      { type: 'TOOL_CALL_START', toolCallId: 'top', toolCallName: 'kubernetes_read' },
      sub,
      { type: 'TOOL_CALL_START', toolCallId: 'inner', toolCallName: 'prometheus_query', subagentRunId: 'sub-1' },
    ]);
    assert.deepEqual(
      state.timeline.map((i) => [i.kind, i.depth]),
      [['tool', 0], ['subagent', 0], ['tool', 1]],
    );
  });

  test('work after the handoff returns to the caller depth', () => {
    const state = reduce([
      started,
      sub,
      { type: 'TOOL_CALL_START', toolCallId: 'inner', toolCallName: 'prometheus_query' },
      { type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    ]);
    assert.equal(state.timeline.at(-1)?.depth, 0);
    assert.deepEqual(state.activeSubagents, []);
  });

  test('nested delegations indent further', () => {
    const state = reduce([
      started,
      sub,
      { type: 'SUBAGENT_STARTED', subagentRunId: 'sub-2', name: 'storage_agent', parentSubagentRunId: 'sub-1' },
      { type: 'TOOL_CALL_START', toolCallId: 'deep', toolCallName: 'kubernetes_read' },
    ]);
    assert.equal(state.timeline.at(-1)?.depth, 2);
  });

  test('participants are collected in first-seen order, without duplicates', () => {
    const state = reduce([
      started,
      sub,
      { type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-1' },
      { type: 'SUBAGENT_STARTED', subagentRunId: 'sub-2', name: 'storage_agent' },
      { type: 'SUBAGENT_FINISHED', subagentRunId: 'sub-2' },
      { type: 'SUBAGENT_STARTED', subagentRunId: 'sub-3', name: 'network_agent' },
    ]);
    assert.deepEqual(state.participants, ['network_agent', 'storage_agent']);
  });

  test('a sub-agent error is shown on the delegation, not swallowed', () => {
    const state = reduce([
      started,
      sub,
      { type: 'SUBAGENT_ERROR', subagentRunId: 'sub-1', message: 'network_agent timed out' },
    ]);
    const item = state.timeline.find((i) => i.kind === 'subagent')!;
    assert.equal(item.kind === 'subagent' && item.status, 'failed');
    assert.equal(item.kind === 'subagent' && item.error, 'network_agent timed out');
    assert.deepEqual(state.activeSubagents, []);
  });

  test('a finished run leaves no agent looking busy', () => {
    const state = reduce([
      started,
      sub,
      {
        type: 'RUN_FINISHED',
        threadId: 't',
        runId: 'r',
        result: { status: 'completed', summary: 's', trace: { trace_id: 't', agent_run_id: 'r' } },
      },
    ]);
    const item = state.timeline.find((i) => i.kind === 'subagent')!;
    assert.equal(item.kind === 'subagent' && item.status, 'done');
    assert.deepEqual(state.activeSubagents, []);
  });

  test('a new run clears the participants', () => {
    const state = reduce([started, sub]);
    const next = applyEvent(state, { type: 'RUN_STARTED', threadId: 't', runId: 'r2' });
    assert.deepEqual(next.participants, []);
    assert.deepEqual(next.activeSubagents, []);
  });
});

describe('human-in-the-loop', () => {
  const paused: AguiEvent[] = [
    started,
    { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Looking.' },
    { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
    {
      type: 'STATE_SNAPSHOT',
      snapshot: {
        plan: [{ id: 'a', label: 'Find', status: 'done' }, { id: 'b', label: 'Assess', status: 'pending' }],
        pendingInput: { prompt: 'Which release?', options: [{ value: '1.41.3', label: '1.41.3' }] },
        result: { status: 'needs_input', summary: 'Which release?', trace: { trace_id: 't', agent_run_id: 'r' } },
      },
    },
    {
      type: 'RUN_FINISHED',
      threadId: 't',
      runId: 'r',
      result: { status: 'needs_input', summary: 'Which release?', trace: { trace_id: 't', agent_run_id: 'r' } },
    },
  ];

  test('a paused run surfaces the question and the needs_input phase', () => {
    const state = reduce(paused);
    assert.equal(state.phase, 'needs_input');
    assert.equal(state.pendingInput?.prompt, 'Which release?');
  });

  test('answering continues the session instead of clearing it', () => {
    const before = reduce(paused);
    // The Portal marks the continuation before starting the resumed run.
    const resuming = applyEvent(
      { ...before, continuation: true },
      { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
    );

    assert.equal(resuming.phase, 'running');
    assert.equal(resuming.runId, 'r2');
    assert.ok(resuming.timeline.length > 0, 'the transcript the user was reading must survive');
    assert.equal(resuming.plan?.length, 2, 'the plan must survive');
    assert.equal(resuming.pendingInput, undefined, 'the question has been answered');
    assert.equal(resuming.result, undefined, 'the paused result is superseded');
    assert.equal(resuming.continuation, false, 'the flag is consumed, not sticky');
  });

  test('a fresh run after a pause still clears everything', () => {
    const before = reduce(paused);
    const fresh = applyEvent(before, { type: 'RUN_STARTED', threadId: 't', runId: 'r3' });
    assert.equal(fresh.timeline.length, 0);
    assert.equal(fresh.pendingInput, undefined);
    assert.equal(fresh.plan, undefined);
  });

  test('timeline ids stay unique when a session continues', () => {
    const before = reduce([
      started,
      { type: 'STEP_STARTED', stepName: 'Kubernetes Agent' },
      { type: 'STEP_FINISHED', stepName: 'Kubernetes Agent' },
    ]);
    const after = reduce(
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
        { type: 'STEP_STARTED', stepName: 'Kubernetes Agent' },
      ],
      { ...before, continuation: true },
    );
    const ids = after.timeline.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate timeline ids: ${ids.join(', ')}`);
  });

  test('a resumed run reusing a tool call id does not rewrite the earlier row', () => {
    const before = reduce([
      started,
      { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'kubernetes_read' },
      { type: 'TOOL_CALL_RESULT', messageId: 'x', toolCallId: 'c1', content: 'first result' },
    ]);
    const after = reduce(
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'prometheus_query' },
        { type: 'TOOL_CALL_RESULT', messageId: 'y', toolCallId: 'c1', content: 'second result' },
      ],
      { ...before, continuation: true },
    );

    const tools = after.timeline.filter((i) => i.kind === 'tool');
    assert.equal(tools.length, 2, 'both runs keep their own row');
    assert.equal(tools[0]!.kind === 'tool' && tools[0]!.result, 'first result');
    assert.equal(tools[1]!.kind === 'tool' && tools[1]!.result, 'second result');
    const ids = after.timeline.map((i) => i.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('the resumed run appends to the same timeline', () => {
    const before = reduce(paused);
    const after = reduce(
      [
        { type: 'RUN_STARTED', threadId: 't', runId: 'r2' },
        { type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'prometheus_query' },
      ],
      { ...before, continuation: true },
    );
    assert.equal(after.timeline.length, before.timeline.length + 1);
  });
});
