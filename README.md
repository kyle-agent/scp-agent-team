# SCP Agent Team

Shared organizational agents for SCP cloud development and operations, reachable
two ways from **one** agent pool:

```text
My Agent ── MCP ──┐
                  ├── SCP Agent Team (kagent)
Me ─────── AG-UI ─┘
```

This repository currently implements **Access Mode 2 — Direct User / AG-UI Portal**
against an existing kagent backend. Mode 1 (MCP) is designed for but not yet built;
see [Status](#status).

## What runs today

| Component | Path | What it does |
|---|---|---|
| Portal | `apps/portal` | Vite + React. Agent catalog, task input, plan checklist, live timeline, nested multi-agent work, tool activity, evidence tabs, root-cause candidates, findings, human-in-the-loop answers, follow-ups, cancel. |
| AG-UI Adapter | `apps/agui-adapter` | Auth, contract validation, audit, and the A2A ⇄ AG-UI event translation. No domain logic. |
| Agent Registry | `packages/agent-registry` | Loads `agents/*/card.json`. The single source of agent definitions for every access mode. |
| Contracts | `packages/contracts` | JSON Schemas + types for AgentCard, AgentInvocation, AgentResult, AuditRecord. |
| Mock kagent | `mocks/kagent-a2a` | A real A2A server with scripted agents, so the whole stack runs with no cluster. |

## Quick start

No Kubernetes cluster required:

```bash
make install
make dev          # mock kagent + adapter + portal
# open http://localhost:5173
```

Against your real kagent:

```bash
kubectl -n kagent port-forward svc/kagent-controller 8083:8083

export KAGENT_BASE_URL=http://127.0.0.1:8083
export SCP_API_TOKEN=<your token>
make dev-cluster
```

Then set each agent's `runtime.namespace` / `runtime.name` in `agents/*/card.json`
to match the kagent `Agent` resources in your cluster, and read
[docs/access-mode-agui.md](docs/access-mode-agui.md#connecting-to-a-real-kagent)
— the tool-activity mapping is the one part that must be verified against a real
cluster.

## Tests

```bash
make test          # everything
make contract-test # schemas, agent cards, tool-blocking policy
make e2e-agui      # full HTTP run: Portal request -> adapter -> A2A -> AG-UI events
```

`make e2e-agui` starts the mock kagent and the adapter as real processes and drives
a complete run over HTTP, asserting the AG-UI event sequence, the result contract,
the write-tool block, and the audit record.

## Status

| Milestone | State |
|---|---|
| M0 — contracts, AgentCard, AgentRegistry | done |
| M1 — MCP access for local agents | **not started** — the registry and contracts are ready for it |
| M2 — real kagent | done (A2A); mock is a drop-in via `KAGENT_BASE_URL` |
| M3 — AG-UI Portal | done |
| M4 — real read-only tools (K8s/Prometheus/Knowledge MCP) | provided by your kagent backend |
| M5 — pilot hardening (OIDC, metrics, rate limits) | partial: bearer auth, audit, timeouts, cancellation, human-in-the-loop |
| M6+ — n8n, Argo, A2A | design only, see `optional/` and `docs/protocol-evolution.md` |

## Documentation

- [docs/architecture.md](docs/architecture.md) — structure and architecture decisions
- [docs/access-mode-agui.md](docs/access-mode-agui.md) — how a kagent A2A stream becomes AG-UI events
- [docs/access-mode-mcp.md](docs/access-mode-mcp.md) — the planned Mode 1 design
- [docs/protocol-evolution.md](docs/protocol-evolution.md) — MCP → A2A, and where A2UI fits
- [docs/local-development.md](docs/local-development.md) — running, mocking, debugging
- [AGENTS.md](AGENTS.md) — rules for code agents working in this repo
