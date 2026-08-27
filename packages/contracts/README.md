# Contracts

The normative artifacts are the JSON Schemas in `schemas/`. `src/types.ts` mirrors
them for TypeScript callers; `src/validate.ts` compiles and enforces them.

| Schema | Used for |
|---|---|
| `agent-card.schema.json` | Agent definitions in `agents/*/card.json`. Generates the Portal catalog and the future MCP tool descriptions — do not maintain that metadata anywhere else. |
| `agent-invocation.schema.json` | Every request to run an agent, in every access mode. Validated before an agent is reached. |
| `agent-result.schema.json` | Every result. Reused for AG-UI state, Portal rendering, the future MCP return value, test assertions and audit. |

The schemas declare JSON Schema 2020-12, so ajv is loaded from its `2020` dialect
entry — the default entry only knows draft-07.

## Rules

- `additionalProperties: false` on the invocation is deliberate: it stops
  credentials being smuggled in as extra fields. There is a test for this.
- The invocation carries no credentials. Auth is a transport concern; the gateway
  holds backend credentials and never passes them through.
- `risk_level: "infra-write"` must not appear on any card until an ADR enables it.
  `make contract-test` asserts this.

## Changing a contract

Change the schema, the type and the tests together. See AGENTS.md.
