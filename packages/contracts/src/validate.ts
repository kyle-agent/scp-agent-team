import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import type { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import type { AgentCard, AgentInvocation, AgentResult } from './types.js';

// The schemas declare JSON Schema 2020-12, so ajv must be loaded from its
// 2020 dialect entry - the default entry only knows draft-07.
// ajv and ajv-formats are CommonJS; under NodeNext their default export has to
// be unwrapped explicitly.
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js') as { new (opts?: object): Ajv2020 };
const addFormats = require('ajv-formats') as FormatsPlugin;

const agentCardSchema = require('../schemas/agent-card.schema.json');
const agentInvocationSchema = require('../schemas/agent-invocation.schema.json');
const agentResultSchema = require('../schemas/agent-result.schema.json');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validators = {
  agentCard: ajv.compile<AgentCard>(agentCardSchema),
  agentInvocation: ajv.compile<AgentInvocation>(agentInvocationSchema),
  agentResult: ajv.compile<AgentResult>(agentResultSchema),
};

export class ContractError extends Error {
  constructor(
    readonly contract: string,
    readonly errors: string[],
  ) {
    super(`${contract} contract violation: ${errors.join('; ')}`);
    this.name = 'ContractError';
  }
}

function explain(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map(
    (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
  );
}

function assertWith<T>(
  validate: ValidateFunction,
  contract: string,
  value: unknown,
): asserts value is T {
  if (!validate(value)) throw new ContractError(contract, explain(validate));
}

export function assertAgentCard(v: unknown): asserts v is AgentCard {
  assertWith<AgentCard>(validators.agentCard, 'AgentCard', v);
}

export function assertAgentInvocation(v: unknown): asserts v is AgentInvocation {
  assertWith<AgentInvocation>(validators.agentInvocation, 'AgentInvocation', v);
}

export function assertAgentResult(v: unknown): asserts v is AgentResult {
  assertWith<AgentResult>(validators.agentResult, 'AgentResult', v);
}

/** Non-throwing variant, for places that must degrade rather than fail (e.g. audit). */
export function checkAgentResult(v: unknown): { ok: true } | { ok: false; errors: string[] } {
  return validators.agentResult(v)
    ? { ok: true }
    : { ok: false, errors: explain(validators.agentResult) };
}
