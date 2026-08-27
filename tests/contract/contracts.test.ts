import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContractError,
  assertAgentCard,
  assertAgentInvocation,
  assertAgentResult,
  checkAgentResult,
} from '@scp/contracts';
import { AgentRegistry } from '@scp/agent-registry';
import { fixtures } from '../../mocks/kagent-a2a/src/fixtures.ts';

const AGENTS_DIR = new URL('../../agents/', import.meta.url).pathname;

describe('agent cards', () => {
  const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

  test('every card on disk satisfies agent-card.schema.json', () => {
    assert.ok(dirs.length >= 2, 'expected at least the two pilot agents');
    for (const dir of dirs) {
      const card = JSON.parse(readFileSync(join(AGENTS_DIR, dir.name, 'card.json'), 'utf8'));
      assert.doesNotThrow(() => assertAgentCard(card), `${dir.name}/card.json`);
    }
  });

  test('no agent is infra-write in the pilot', () => {
    for (const card of AgentRegistry.fromDirectory(AGENTS_DIR).list()) {
      assert.equal(card.risk_level, 'read-only', `${card.id} must stay read-only until an ADR enables writes`);
    }
  });
});

describe('registry', () => {
  const registry = AgentRegistry.fromDirectory(AGENTS_DIR);

  test('exposes both pilot agents', () => {
    assert.deepEqual(
      registry.list().map((a) => a.id),
      ['architecture_agent', 'kubernetes_agent'],
    );
  });

  test('unknown agent names fail loudly', () => {
    assert.throws(() => registry.require('network_agent'), /unknown agent/);
  });

  test('read tools are allowed', () => {
    assert.doesNotThrow(() => registry.assertToolAllowed('kubernetes_agent', 'kubernetes_read'));
    assert.doesNotThrow(() => registry.assertToolAllowed('kubernetes_agent', 'prometheus_query'));
    assert.doesNotThrow(() => registry.assertToolAllowed('architecture_agent', 'knowledge_search'));
  });

  test('write tools are blocked for a read-only agent (SPEC 14)', () => {
    for (const tool of ['apply', 'patch', 'delete', 'exec', 'scale', 'rollout-restart', 'helm upgrade']) {
      assert.throws(
        () => registry.assertToolAllowed('kubernetes_agent', tool),
        /blocked|write operation/,
        `${tool} must be refused`,
      );
    }
  });

  test('blocked-tool matching respects token boundaries', () => {
    // "dispatch_query" contains the substring "patch" but is not a write.
    assert.doesNotThrow(() => registry.assertToolAllowed('kubernetes_agent', 'dispatch_query'));
  });
});

describe('invocation contract', () => {
  const valid = {
    request_id: 'req-1',
    agent: 'architecture_agent',
    task: 'Review this design.',
    actor: { type: 'portal' as const, user_id: 'u1' },
    correlation: { trace_id: 'trace-1' },
  };

  test('accepts a minimal valid invocation', () => {
    assert.doesNotThrow(() => assertAgentInvocation(valid));
  });

  test('rejects an empty task', () => {
    assert.throws(() => assertAgentInvocation({ ...valid, task: '' }), ContractError);
  });

  test('rejects an unknown actor type', () => {
    assert.throws(
      () => assertAgentInvocation({ ...valid, actor: { type: 'robot', user_id: 'u1' } }),
      ContractError,
    );
  });

  test('rejects credentials smuggled in as extra top-level fields', () => {
    assert.throws(
      () => assertAgentInvocation({ ...valid, kubeconfig: 'secret' }),
      ContractError,
    );
  });
});

describe('result contract', () => {
  test('mock fixtures produce schema-valid results once trace is attached', () => {
    for (const [name, fixture] of Object.entries(fixtures)) {
      const withTrace = { ...fixture.result, trace: { trace_id: 't', agent_run_id: 'r' } };
      const check = checkAgentResult(withTrace);
      assert.ok(check.ok, `${name}: ${check.ok ? '' : check.errors.join('; ')}`);
    }
  });

  test('requires a trace', () => {
    assert.throws(
      () => assertAgentResult({ status: 'completed', summary: 'x' }),
      ContractError,
    );
  });
});
