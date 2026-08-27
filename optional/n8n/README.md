# Business workflow capability (n8n) — interface only

**Not implemented, and not a runtime dependency.** Nothing in the request path
depends on this.

n8n is not the front door. An agent that concludes a business action is needed
does not call n8n — it returns a `requested_capabilities` entry in its
`AgentResult`, and a human decides.

```json
{ "requested_capabilities": [
    { "capability": "createIncident",
      "parameters": { "service": "checkout", "severity": "SEV2" },
      "requires_approval": true } ] }
```

The Portal renders these as *requested and not executed*.

## When n8n earns its place

Use it when several business systems participate, order matters, and retry,
approval, notification or business audit are required:

```text
kagent ─► createIncident() ─► n8n ─► Jira + owner mapping + Teams + Confluence + CMDB
```

Do **not** use it for a Jira search, a Confluence read, a Prometheus query or a
Kubernetes get. Those go straight to MCP. Putting a workflow engine in front of a
read adds latency and a failure mode for nothing.

## Planned capabilities

```text
createIncident(service, severity, summary, evidence) -> incident_id
publishAnalysis(target, title, body)                 -> url
notifyOwner(service, channel, message)               -> ack
requestApproval(action, context)                     -> approval_id
```

Building this means: a `BusinessCapability` interface next to `AgentInvoker`, an
n8n-backed implementation, an approval gate before any of them run, and an ADR.
