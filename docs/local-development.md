# Local development

## Running

```bash
make install
make dev
```

Three processes start:

| Port | Process |
|---|---|
| 5173 | Portal (Vite). Proxies `/agui` and `/api` to the adapter, so the browser stays same-origin and SSE never hits a CORS preflight. |
| 8090 | AG-UI adapter |
| 8099 | Mock kagent A2A server |

Open <http://localhost:5173>, pick an agent, click one of the example tasks, Run.

## Mock mode

`mocks/kagent-a2a` is a real A2A server, not a stub inside the adapter. It speaks
JSON-RPC `message/stream` over SSE at `/api/a2a/{namespace}/{agent}/`, so the
adapter's production A2A client and event mapper are the code that actually runs
in mock mode. Only the agent's reasoning is scripted.

It also streams text *cumulatively* on purpose — the harder of the two real-world
behaviours — so the de-duplication path is covered by default.

Fixtures live in `mocks/kagent-a2a/src/fixtures.ts`, keyed by the card's
`runtime.name`.

## Against a real kagent

```bash
kubectl -n kagent port-forward svc/kagent-controller 8083:8083
export KAGENT_BASE_URL=http://127.0.0.1:8083
export SCP_API_TOKEN=<token>
make dev-cluster
```

See [access-mode-agui.md](access-mode-agui.md#connecting-to-a-real-kagent) for
what to check first.

## Tests

```bash
make test           # everything
make contract-test  # schemas, cards, tool policy      (no processes)
make e2e-agui       # full HTTP stack                  (spawns mock + adapter)
npm run test -w @scp/agui-adapter   # A2A -> AG-UI mapping units
npm run test -w @scp/portal         # run-state reducer units
```

Two things to know if you edit the E2E harness:

- Spawn servers as `node --import tsx <script>`, not via the `tsx` binary. The
  binary is a wrapper that spawns node as a grandchild; killing the wrapper
  orphans the real server, which keeps the port and breaks the next run with
  `EADDRINUSE`.
- Drain both child pipes. The adapter logs an audit line per run, and a full pipe
  blocks the child mid-stream.

## Debugging a run

Every response carries `X-Scp-Run-Id` and `X-Scp-Trace-Id`, and the same trace id
appears in the audit log and in the `AgentResult`.

```bash
# Raw AG-UI event stream
curl -N -X POST localhost:8090/agui/run \
  -H 'authorization: Bearer dev-token' -H 'x-scp-user: me' \
  -H 'content-type: application/json' \
  -d '{"agent":"kubernetes_agent","task":"checkout is slow"}'

# What kagent actually sent, before mapping
curl -N -X POST localhost:8099/api/a2a/kagent/k8s-agent/ \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/stream",
       "params":{"message":{"kind":"message","role":"user","messageId":"m1",
                            "parts":[{"kind":"text","text":"hi"}]}}}'

# Audit
jq . audit/agent-access.jsonl | tail -40
```

Comparing those two streams is the fastest way to tell a mapping problem from an
agent problem.

## Environment

Copy `.env.example`. `SCP_API_TOKEN` is required — the adapter refuses to start
without it rather than serving agents anonymously.
