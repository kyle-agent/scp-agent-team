# MCP servers

Empty for now. Two different things will live here:

**`public-agents/`** — the MCP server that exposes SCP's shared agents to local
code agents (Access Mode 1). Designed in
[../docs/access-mode-mcp.md](../docs/access-mode-mcp.md); the registry, contracts
and invoker it needs already exist.

**`kubernetes/`, `prometheus/`, `knowledge/`** — engineering tools *for* the
agents. In this pilot these are configured in kagent, not here: kagent owns the
agents and their tool connections, and this repository is the access plane in
front of it. Add them here only if the pilot needs a tool kagent cannot provide.

Note the direction of the two, they are easy to confuse:

```text
Local Agent ──MCP──► public-agents ──► kagent      MCP in front of the agents
                                          │
                                         MCP
                                          ▼
                              kubernetes / prometheus / knowledge
                                                   MCP behind the agents
```
