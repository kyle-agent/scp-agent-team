import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PlanTextFilter, detectPlanSignal, normalizeSteps } from '../src/kagent/plan.ts';

const BLOCK = [
  '[PLAN]',
  '- [ ] Check pod status (kubernetes_read)',
  '- [ ] Analyse latency (prometheus_query)',
  '- [ ] Check network path',
  '[/PLAN]',
].join('\n');

/** Feeds text through the filter in fixed-size chunks, as a stream would. */
function stream(text: string, size: number) {
  const filter = new PlanTextFilter();
  let display = '';
  let steps;
  for (let i = 0; i < text.length; i += size) {
    const out = filter.push(text.slice(i, i + size));
    display += out.text;
    if (out.steps) steps = out.steps;
  }
  return { display: display + filter.flush(), steps };
}

describe('plan text filter', () => {
  test('extracts a checklist and removes it from the displayed text', () => {
    const { display, steps } = stream(`Before.\n${BLOCK}\nAfter.`, 1000);
    assert.equal(display, 'Before.\n\nAfter.');
    assert.deepEqual(
      steps?.map((s) => [s.label, s.tool, s.status]),
      [
        ['Check pod status', 'kubernetes_read', 'pending'],
        ['Analyse latency', 'prometheus_query', 'pending'],
        ['Check network path', undefined, 'pending'],
      ],
    );
  });

  test('survives the markers being split across every chunk boundary', () => {
    // Character-at-a-time is the worst case: "[PLAN]" arrives as six chunks.
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const { display, steps } = stream(`Before.\n${BLOCK}\nAfter.`, size);
      assert.equal(display, 'Before.\n\nAfter.', `chunk size ${size}`);
      assert.equal(steps?.length, 3, `chunk size ${size}`);
    }
  });

  test('never leaks a partial marker into displayed text', () => {
    const filter = new PlanTextFilter();
    // "[PLA" could still become "[PLAN]", so it must be held back.
    assert.equal(filter.push('done [PLA').text, 'done ');
    assert.equal(filter.push('N]\n- [ ] Step one\n[/PLAN]').steps?.length, 1);
  });

  test('text that merely looks like a marker is still displayed', () => {
    const filter = new PlanTextFilter();
    const first = filter.push('see [PLA');
    const second = filter.push('CEHOLDER] for details');
    assert.equal(first.text + second.text + filter.flush(), 'see [PLACEHOLDER] for details');
  });

  test('an unterminated block does not swallow the rest of the run', () => {
    const { display, steps } = stream('Working.\n[PLAN]\n- [ ] Something', 4);
    assert.equal(display, 'Working.\n');
    assert.equal(steps, undefined);
  });

  test('accepts a JSON block too', () => {
    const json = '[PLAN]\n[{"id":"a","label":"Look","tool":"knowledge_search"}]\n[/PLAN]';
    const { steps } = stream(json, 6);
    assert.deepEqual(steps, [
      { id: 'a', label: 'Look', status: 'pending', tool: 'knowledge_search' },
    ]);
  });

  test('text with no plan passes through untouched', () => {
    const { display, steps } = stream('Just an ordinary answer.', 3);
    assert.equal(display, 'Just an ordinary answer.');
    assert.equal(steps, undefined);
  });
});

describe('plan normalisation', () => {
  test('assigns ids and defaults status to pending', () => {
    assert.deepEqual(normalizeSteps([{ label: 'One' }, { label: 'Two' }]), [
      { id: 'step-1', label: 'One', status: 'pending' },
      { id: 'step-2', label: 'Two', status: 'pending' },
    ]);
  });

  test('de-duplicates ids the agent repeated', () => {
    const steps = normalizeSteps([
      { id: 'x', label: 'One' },
      { id: 'x', label: 'Two' },
    ]);
    assert.deepEqual(steps?.map((s) => s.id), ['x', 'x-2']);
  });

  test('drops entries with no label rather than inventing one', () => {
    assert.deepEqual(normalizeSteps([{ label: 'Keep' }, { tool: 'x' }])?.length, 1);
  });

  test('rejects a nonsense status instead of trusting it', () => {
    assert.equal(normalizeSteps([{ label: 'One', status: 'ᕕ( ᐛ )ᕗ' }])?.[0]?.status, 'pending');
  });

  test('returns undefined for input that is not a plan', () => {
    for (const bad of [undefined, null, [], {}, 'nope', [{}]]) {
      assert.equal(normalizeSteps(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('plan data parts', () => {
  test('recognises a plan declaration', () => {
    const signal = detectPlanSignal({
      kind: 'data',
      data: { kind: 'plan', plan: [{ id: 's1', label: 'Look', tool: 'knowledge_search' }] },
    });
    assert.equal(signal?.kind, 'plan');
    assert.equal(signal?.kind === 'plan' && signal.steps[0]?.label, 'Look');
  });

  test('recognises a step update', () => {
    const signal = detectPlanSignal({
      kind: 'data',
      data: { kind: 'plan-step', id: 's1', status: 'skipped', detail: 'not needed' },
    });
    assert.deepEqual(signal, { kind: 'plan-step', id: 's1', status: 'skipped', detail: 'not needed' });
  });

  test('ignores a step update with an unknown status', () => {
    assert.equal(
      detectPlanSignal({ kind: 'data', data: { kind: 'plan-step', id: 's1', status: 'wat' } }),
      undefined,
    );
  });

  test('ignores unrelated parts', () => {
    assert.equal(detectPlanSignal({ kind: 'text', text: '[PLAN]' }), undefined);
    assert.equal(detectPlanSignal({ kind: 'data', data: { kind: 'tool-call', name: 'x' } }), undefined);
  });
});
