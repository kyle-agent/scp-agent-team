# Rules for code agents working in this repository

## The one principle

**One shared SCP Agent Team, multiple ways to collaborate with it.**

There are two first-class access modes. They are adapters over the *same* agents.

```text
Local Code Agent ── MCP ───┐
                           ├── AgentInvoker ── kagent
Human ── Portal ── AG-UI ──┘
```

## Hard rules

1. **Never duplicate an agent per access mode.** There is no
   `architecture_agent_for_portal`. Agents are defined once in `agents/*/card.json`
   and loaded by `AgentRegistry`. If you add an access mode, add an adapter.
2. **kagent stays the agent runtime.** This repo does not implement agent
   reasoning. `apps/agui-adapter` maps protocols; it must not acquire domain logic.
3. **MCP is Local Agent access. AG-UI is Direct User access. A2A is a future
   adapter.** Do not build an exposure that forecloses A2A — go through
   `AgentInvoker` (`apps/agui-adapter/src/invoker.ts`).
4. **Infra write is forbidden** until explicitly enabled by an ADR. Agents are
   `read-only`; `AgentRegistry.assertToolAllowed` refuses to relay a write tool
   even if kagent is misconfigured. Do not weaken it to make a test pass.
5. **n8n is optional business workflow, not middleware. Argo is optional infra
   execution.** Neither may sit in the request path of a simple read. An agent
   that wants one emits a `requested_capabilities` entry; it does not call it.
6. **Simple reads use direct tools/MCP**, never a workflow engine.
7. **Access must never be anonymous.** The adapter refuses to start without
   `SCP_API_TOKEN`.
8. **Every invocation is audited** with `access_mode`, `trace_id` and the tools
   that ran — that is how the two modes get compared.

## When you change an interface

Update all three together, in the same change:

- the JSON Schema in `packages/contracts/schemas/`
- the TypeScript type in `packages/contracts/src/types.ts`
- the contract test in `tests/contract/` and the E2E in `tests/e2e/`

A contract change that does not touch the tests is incomplete.

## Layout

```text
agents/<name>/card.json      agent definitions - the single source of truth
packages/contracts           schemas + types + validation
packages/agent-registry      card loading, tool policy
apps/agui-adapter            AG-UI <-> kagent A2A (Mode 2)
apps/portal                  the Portal UI
mocks/kagent-a2a             a real A2A server with scripted agents
optional/                    n8n and Argo: interface design only, no runtime
tests/contract, tests/e2e    contract validation and full-stack runs
```

Deviation from the original spec: the spec sketched a top-level `contracts/`
directory. It lives at `packages/contracts/` instead so both the adapter and the
future MCP server can import it as a workspace package. The schemas are in
`packages/contracts/schemas/` and are the normative artifacts.

## Adding an agent

1. Create `agents/<name>/card.json`. `id` is also the future MCP tool name, and
   `description` is what makes a local agent pick the right specialist — write it
   for that reader.
2. Set `runtime.namespace` / `runtime.name` to the kagent `Agent` resource.
3. List `blocked_tools` for anything it must never invoke.
4. Add a fixture in `mocks/kagent-a2a/src/fixtures.ts` keyed by `runtime.name`.
5. Run `make contract-test`.

Nothing else. Both the Portal catalog and the future MCP tool list pick it up.
