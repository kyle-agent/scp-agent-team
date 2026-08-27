# Access Mode 2 — Portal / AG-UI

## The wire

Portal → adapter is one POST that returns a Server-Sent Events stream:

```http
POST /agui/run
Authorization: Bearer <SCP_API_TOKEN>
X-Scp-User: <user id>
Content-Type: application/json

{ "agent": "kubernetes_agent", "task": "...", "threadId": "...", "runId": "...",
  "context": { "service": "checkout", "environment": "prod" },
  "artifacts": [{ "name": "deploy.yaml", "content": "..." }] }
```

```http
200 OK
Content-Type: text/event-stream
X-Scp-Run-Id: <runId>
X-Scp-Trace-Id: <traceId>

data: {"type":"RUN_STARTED","threadId":"...","runId":"..."}

data: {"type":"TOOL_CALL_START","toolCallId":"c1","toolCallName":"kubernetes_read"}
...
data: {"type":"RUN_FINISHED","threadId":"...","runId":"...","result":{...}}
```

`EventSource` is not used: the run is a POST carrying the invocation and it needs
an `Authorization` header, and `EventSource` supports neither. The Portal reads
the stream with `fetch` + `ReadableStream`.

Adapter → kagent is A2A JSON-RPC:

```http
POST {KAGENT_BASE_URL}/api/a2a/{namespace}/{agent}/
{"jsonrpc":"2.0","id":"<request_id>","method":"message/stream",
 "params":{"message":{"kind":"message","role":"user","messageId":"...",
                      "parts":[{"kind":"text","text":"..."}],"contextId":"..."}}}
```

## Event mapping

| A2A | AG-UI | Notes |
|---|---|---|
| `Task` (initial) | `STEP_STARTED` | captures `taskId` / `contextId` |
| `status-update` with a text part | `TEXT_MESSAGE_START` / `_CONTENT` / `_END` | see *cumulative text* below |
| data part recognised as a tool call | `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` | checked against the tool policy first |
| data part recognised as a tool result | `TOOL_CALL_RESULT` | also becomes evidence in the fallback path |
| any other data part | `CUSTOM` (`a2a.data_part`) | never dropped |
| `artifact-update` carrying a valid AgentResult | adopted as the run result | validated before adoption |
| `artifact-update`, anything else | `CUSTOM` (`a2a.artifact`) + evidence | |
| data part `{kind:"plan"}`, or a `[PLAN]` block in text | `STATE_SNAPSHOT` carrying the plan | see *the plan* below |
| data part `{kind:"plan-step"}` | `STATE_SNAPSHOT` with that step updated | |
| terminal `status-update` | `STEP_FINISHED`, `STATE_SNAPSHOT`, `RUN_FINISHED` | |

### Cumulative text

Some A2A servers stream deltas; others resend the whole message on every update.
The adapter tracks what it has already emitted per `messageId` and sends only the
new suffix, so both behave identically downstream. Without this, a cumulative
server makes the Portal print `Checking Checking workload Checking workload
health`. The mock deliberately streams cumulatively so the E2E test covers the
harder case.

### The result

An agent that emits a JSON object matching `agent-result.schema.json` (as a data
part or as JSON text in an artifact) has it adopted, with the trace stamped in.
Anything else falls back to a synthesised result: the accumulated assistant text
as `summary`, tool outputs as `evidence`. The Portal renders both the same way,
so agents can be taught the structured format one at a time.

When an agent supplies its own `evidence`, raw tool output is *not* appended to
it — that output is already in the timeline, and appending it duplicated every
row in the evidence panel.

## The plan

Tool events can only report what already happened, so a purely reactive timeline
can show a running step and a finished one but never an upcoming one. Rendering
`○ Check network path — planned` requires the agent to say in advance what it
intends to do. That declaration travels in AG-UI **shared state**
(`STATE_SNAPSHOT`), which is the protocol's mechanism for state that is mutated
over the life of a run.

Snapshots rather than `STATE_DELTA` patches: a plan is a handful of steps, so
resending it costs nothing measurable, and every AG-UI client works without a
JSON Patch implementation. Revisit if plans ever get large.

### How an agent declares one

Two ways, both supported:

```text
1. A DataPart      { "kind": "plan", "plan": [ {id, label, tool} ] }
2. A text block    [PLAN]
                   - [ ] Check pod status (kubernetes_read)
                   - [ ] Analyse latency (prometheus_query)
                   [/PLAN]
```

The text form exists because most kagent agents can only emit text — custom
DataParts depend on the framework underneath. `composePrompt` asks every agent
for the block, so this works without changing anything in the cluster. The block
is stripped from what the Portal displays, so the plan renders as a checklist
rather than appearing twice.

Text arrives in arbitrary chunks, so `PlanTextFilter` holds back any trailing
fragment that could still grow into a marker. Without that, a `[PLAN]` split
across two updates is consumed as prose and the block never opens. The mock
streams the block three characters at a time to keep this covered.

### How steps advance

- **Automatically**, when a step names a `tool` and that tool fires: `pending →
  running` on the call, `running → done` on the result. The agent only has to
  declare the plan once.
- **Explicitly**, when the agent sends `{kind:"plan-step", id, status, detail}` —
  needed for steps with no tool, and for reporting a step it decided to skip.

### Steps must not be left pending

When a run ends, any step still `pending` becomes `skipped` and any step still
`running` becomes `done` (or `failed` if the run failed). A checklist that
promises work the agent never did is worse than no checklist, so the run's end
settles every step. There is a test for exactly this.

If the agent declares no plan, there is no plan state and the Portal shows the
reactive timeline alone — no degradation elsewhere.

## Tool policy

`AgentRegistry.assertToolAllowed` runs on every observed tool call. It rejects
anything in the card's `blocked_tools` and, for a `read-only` agent, anything
whose leading token is a write verb (`apply`, `patch`, `delete`, `exec`,
`create`, `update`, `scale`, `restart`, `rollout`). Matching is on `_`-separated
token boundaries, so `dispatch_query` does not trip the `patch` rule.

This is defence in depth. kagent RBAC is still the primary control — this only
guarantees the gateway refuses to relay a run that tries a write.

## Connecting to a real kagent

1. Reach the controller's A2A port:
   `kubectl -n kagent port-forward svc/kagent-controller 8083:8083`
2. `export KAGENT_BASE_URL=http://127.0.0.1:8083`
3. Point each card's `runtime` at a real agent, and confirm it:
   ```bash
   curl -s localhost:8083/api/a2a/kagent/<agent-name>/.well-known/agent.json | jq .
   ```
   `capabilities.streaming` must be `true`.
4. `make dev-cluster`

### The one thing to verify against a real cluster

**Tool activity.** A2A has no normative shape for tool calls — they travel in
DataParts whose layout depends on which framework kagent runs the agent under
(ADK, LangGraph, CrewAI…). `apps/agui-adapter/src/kagent/tool-signal.ts` casts a
wide net over the shapes those frameworks emit, but it is a net, not a standard.

Everything else in the pipeline is normative A2A and needs no verification.

If your timeline shows text and a final result but **no tool rows**, the shapes
did not match. Nothing is lost — unmatched data parts arrive as `CUSTOM` events
and are visible in the Portal timeline as raw JSON. Read one, then add its shape
to `detectToolSignal` and a case to `apps/agui-adapter/test/map-to-agui.test.ts`.

## Sessions and cancellation

`threadId` is one Portal session. The adapter remembers the kagent `contextId`
per thread, so a follow-up continues the same kagent conversation rather than
starting cold.

Cancel does two things: aborts the browser's fetch, and `POST
/api/runs/{runId}/cancel` so the adapter aborts the upstream A2A call rather than
leaving kagent working on an abandoned run. The run still gets a terminal
`RUN_FINISHED` with `status: "cancelled"`, and the audit record says so.

Note for anyone editing the adapter: listen for disconnects on the **response**
(`res.on('close')`), not the request. `req` emits `close` as soon as its body has
been parsed, which would abort every run the moment it started.
