# Access Mode 1 — Local Agent / MCP

**Status: designed, not implemented.** The contracts, `AgentRegistry` and
`AgentInvoker` this needs already exist and are exercised by Mode 2.

## Goal

A developer's Codex / Claude Code / Cursor session keeps its own context —
repository, git history, local files, build output — and calls SCP's shared
agents for what it cannot know: organization standards, approved patterns, cluster
operational expertise.

```text
Codex
  ├─ reads the local repo
  └─ architecture_agent({task, context, artifacts})
             │  MCP
             ▼
       SCP Agent Team ──► organization standards, patterns
             │
             ▼
       AgentResult ──► Codex merges it into the design and the code
```

## Tool surface

One MCP tool per shared agent, named by the card's `id`:

```text
architecture_agent
kubernetes_agent
```

Not a single generic `run_any_agent`. The local agent picks the specialist from
the tool description, so each card's `description` is written for that reader —
it says what the agent knows and, just as importantly, what it is not for.

Tool input mirrors `agent-invocation.schema.json` minus the fields the server
fills in (`request_id`, `actor`, `correlation`):

```json
{ "task": "string", "context": {}, "artifacts": [], "constraints": [] }
```

## What building it involves

1. An MCP server in `mcp/public-agents/` that enumerates `AgentRegistry.list()`
   and registers one tool per card, generating the description from the card.
2. An `McpAgentAdapter` that builds an `AgentInvocation` with
   `actor.type: "local-agent"`, calls the same `AgentInvoker`, drains the AG-UI
   events, and returns the `AgentResult` as the tool result.
3. Auth: a per-user token rather than the Portal's shared one. Local agents must
   never receive backend credentials — the gateway holds them.
4. Audit with `access_mode: "local-agent"`, so the two modes can be compared on
   identical records.

The invoker, registry, contracts, tool policy and audit format are all reused
as-is. That reuse is the point of the seams.

## Comparing the two modes

Both write the same `AuditRecord`, differing only in `access_mode` and `client`:

```bash
jq -r 'select(.access_mode=="local-agent") | [.agent,.duration_ms,.status] | @tsv' audit/agent-access.jsonl
jq -r 'select(.access_mode=="portal")      | [.agent,.duration_ms,.status] | @tsv' audit/agent-access.jsonl
```
