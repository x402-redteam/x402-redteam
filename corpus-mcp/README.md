# corpus-mcp

The MCP corpus (ADR-035). Scenarios here have `transport: mcp` and at least one tool route
(`routes[].tool`), and are served by the adversary as paywalled MCP tools at `POST /mcp`.

- The loader refuses a scenario here with no tool route, and refuses `transport: mcp` under
  `corpus/`. `corpus/` stays the HTTP corpus; its `corpus_hash` does not change.
- This corpus has its own `corpus_hash`, its own reference results (`results/mcp/`) and its
  own leaderboard section. Its numbers never mix into the HTTP aggregate.
- Run it with `run --corpus corpus-mcp`. The guardrail track refuses MCP scenarios until an
  MCP guardrail driver exists.

It is empty for now; the scenarios arrive in U30-3.
