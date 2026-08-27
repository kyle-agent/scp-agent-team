# Infra runbook capability (Argo Workflows) — design only

**Not implemented. Infra write is forbidden until an ADR enables it** (see
AGENTS.md rule 4). `AgentRegistry.assertToolAllowed` blocks write tools today,
and agents are declared `read-only` in their cards.

The principle:

> **The agent decides. A deterministic system executes.**

The agent never performs an infrastructure change. It diagnoses, recommends, and
a human approves; Argo owns the procedure.

```text
Agent diagnosis
   ↓
Rollback recommendation        (AgentResult.recommendations, risk: infra-write)
   ↓
User / business approval       (human, outside the agent)
   ↓
executeRunbook(runbook_id, parameters, approval_context)
   ↓
Argo Workflows ─► Infrastructure
   ↓
Agent verification             (a new read-only run)
```

## Interface

```text
executeRunbook(
  runbook_id,          a pre-approved, version-controlled runbook - never ad hoc steps
  parameters,          validated against that runbook's schema
  approval_context     who approved, when, against which finding
) -> run_id
```

Runbooks are approved artifacts. The agent chooses *which* runbook and supplies
parameters; it cannot compose one. Examples: rollback, restart, scale, deploy,
post-change validation.

## Before any of this can be built

- an ADR enabling infra write, naming who may approve what
- the approval path, with the approver's identity in the audit record
- per-runbook RBAC — the gateway's credentials, never the user's
- a verification run after every execution, and a documented failure path
