# Architecture

## Shape

```text
┌───────────────────────── ACCESS PLANE ─────────────────────────┐
│                                                                │
│  Mode 1 (planned)                    Mode 2 (implemented)      │
│  Codex / Claude Code / Cursor        Browser                   │
│         │                                   │                  │
│        MCP                                Portal               │
│         │                                 AG-UI                │
└─────────┼───────────────────────────────────┼──────────────────┘
          │                                   │
          └────────────┬──────────────────────┘
                       ▼
             ┌──────────────────┐
             │  AgentInvoker    │   internal seam - every mode goes through it
             └────────┬─────────┘
                      │  A2A JSON-RPC (message/stream)
                      ▼
             ┌──────────────────┐
             │      kagent      │   ArchitectureAgent, KubernetesAgent
             └────────┬─────────┘
                      │ MCP
                      ▼
        Kubernetes / Prometheus / Knowledge (read-only)
```

## Request path (Mode 2, as built)

```text
Portal
  │  POST /agui/run  {agent, task, context, artifacts, threadId, runId}
  ▼
bearerAuth ──────────► 401 if absent or wrong
  │
assertAgentInvocation ► 400 before the stream opens, so bad input is a real
  │                      HTTP error rather than a 200 that dies mid-stream
registry.require ─────► 404 for an unknown agent
  │
  ▼
A2AAgentInvoker
  │  composePrompt(invocation, card)     contract -> the one text part A2A carries
  │  POST {kagent}/api/a2a/{ns}/{name}/  method: message/stream
  ▼
A2AToAguiMapper        A2A results -> AG-UI events, and an AgentResult
  │
  ▼
SSE: RUN_STARTED, STEP_STARTED, TEXT_MESSAGE_*, TOOL_CALL_*, STATE_SNAPSHOT, RUN_FINISHED
  │
  ▼
AuditLog               one line per run: trace, user, access_mode, tools, duration
```

## Why the seams sit where they do

**`AgentRegistry` reads cards from disk, not from code.** The Portal catalog and
the future MCP tool list are two renderings of the same `agents/*/card.json`.
That is the mechanical guarantee behind "do not duplicate agents per access
mode" — there is no second place to register one.

**`AgentInvoker` returns AG-UI events and *returns* an `AgentResult`.** AG-UI's
event vocabulary is a superset of what MCP needs, so an MCP adapter can drain the
events it does not care about and keep the return value. One invoker serves both
modes without a third intermediate event format.

**The adapter validates before opening the stream.** Once an SSE response starts,
the status code is already 200 and every failure has to be reported inside the
stream. Validating first keeps ordinary client errors as ordinary HTTP errors.

**Write blocking lives in the registry, not the route.** `assertToolAllowed` is
called from the mapper as tool activity arrives, so it applies to every access
mode. It is defence in depth behind kagent RBAC, not a replacement for it.

## Architecture decisions

**ADR-001** — SCP Agent Team is a shared agent capability, not only a portal.

**ADR-002** — Two first-class access modes: Local Agent and Direct User.

**ADR-003** — MCP is the initial Local Agent access protocol.

**ADR-004** — AG-UI is the Direct User interaction protocol.

**ADR-005** — The same kagent agent pool serves both access modes.

**ADR-006** — n8n is optional business workflow capability, not mandatory
middleware.

**ADR-007** — Argo is optional deterministic infra execution.

**ADR-008** — A2A is the future peer-agent collaboration path. Note that this
repo already speaks A2A *downward* to kagent; ADR-008 concerns A2A *sideways*,
between a user's local agent and this team as peers.

**ADR-009 — A2UI is not adopted for the pilot, and the seam for it is kept
open.** A2UI (Google's declarative generative-UI format) is not an alternative to
AG-UI; AG-UI is the transport and A2UI is a payload that can ride on it. The
pilot's screens are driven by `agent-result.schema.json`, whose shape is fixed
and known ahead of time, so agent-generated layout buys nothing today — while
A2UI would cost a renderer (no first-party React one exists) and changes to the
kagent agents to make them emit it, against a spec still at release-candidate.
The pilot therefore renders the result contract directly. Adoption is kept cheap:
anything the adapter cannot classify already reaches the Portal as an AG-UI
`CUSTOM` event and lands in `apps/portal/src/components/UIBlock.tsx`, where a
renderer keyed on the event name can be registered without touching the adapter,
the transport, or the timeline. Revisit when Phase 3/4 introduces approval forms
and per-agent evidence widgets, where the agent — not the frontend — decides
what to draw.

**ADR-010 — AG-UI's event set is the internal run vocabulary.** Rather than
inventing a neutral third event type between `AgentInvoker` and its adapters, the
invoker emits AG-UI events directly and returns the `AgentResult`. Consequence: a
future MCP adapter ignores the events and uses the return value; a future A2A
adapter maps them. Revisit if a mode needs an event AG-UI cannot express.
