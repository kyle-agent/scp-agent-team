# Protocol evolution

## Where each protocol sits

```text
Local Agent ──── MCP ────┐   planned    tool-style invocation
Local Agent ──── A2A ────┤   future     peer collaboration
Human ── Portal ─ AG-UI ─┤   built      this repository
                         ▼
                  AgentInvoker
                         │  A2A  (already)
                         ▼
                      kagent
                         │  MCP
                         ▼
             Kubernetes / Prometheus / Knowledge
```

Note the asymmetry: this repo already speaks **A2A downward** to kagent, because
that is how kagent exposes agents. The "future A2A" in ADR-008 is different — it
is A2A *sideways*, a user's local agent and this team collaborating as peers
rather than the local agent calling this team as a tool.

MCP and A2A are not mutually exclusive:

```text
MCP = agent/tool style invocation   - one request, one result
A2A = peer agent collaboration      - delegation, long-running tasks, negotiation
```

Both can run at once. MCP is the right first step because today's local agents
already model remote capability as a tool.

## Keeping A2A possible

Everything goes through `AgentInvoker` (`apps/agui-adapter/src/invoker.ts`):

```text
AgentInvoker
  ├─ A2AAgentInvoker      kagent over A2A          (implemented)
  ├─ McpAgentAdapter      Mode 1                   (planned, consumes the invoker)
  └─ PeerA2AAdapter       Mode 1 as peers          (future)
```

Adapters depend on `AgentRegistry`, `AgentInvoker`, `AgentCard`, `AgentResult`,
`AuthContext` and `TraceContext` — never on each other. Nothing in the AG-UI route
is reachable only through AG-UI.

## Where A2UI fits

A2UI is often mistaken for an AG-UI competitor. It is not — it is a layer above:

```text
A2UI / MCP-UI / Open-JSON-UI     what UI to show   (declarative payload)
            ▼
          AG-UI                  how to deliver it (transport, this repo)
            ▼
      Portal frontend
```

A2UI's own transports are A2A and AG-UI, so adopting it would not replace
anything here.

It is deliberately not adopted for the pilot (ADR-009): the Portal's screens are
driven by `agent-result.schema.json`, a shape known ahead of time, so there is
nothing for the agent to decide about layout — while the cost is a React renderer
that does not exist first-party plus changes to the kagent agents to emit A2UI,
against a spec still at RC.

The seam is kept open at no cost:

1. Unclassified agent output already arrives as an AG-UI `CUSTOM` event.
2. `apps/portal/src/components/UIBlock.tsx` dispatches those by name and today
   falls back to a JSON inspector.
3. Adopting A2UI means registering a renderer under the key `a2ui` and teaching
   the agents to emit it. The adapter, the transport and the timeline do not
   change.

Reconsider when Phase 3/4 arrives: approval forms for Argo runbooks, incident
creation forms whose fields vary per Jira project, and per-agent evidence widgets
are cases where the agent genuinely knows what to draw and the frontend does not.
A Flutter operations app would be a second reason, since the same payload renders
natively there.
