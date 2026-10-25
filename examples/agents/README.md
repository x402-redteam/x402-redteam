# examples/agents

Reference agents and test probes. `naive`, `guarded` and `llm` are the reference agents;
`sdk-default`, `promptonly`, `obedient` and `hostname-allowlist` are internal baselines and
probes. They are harness oracles, not evidence that any real agent is safe (ADR-008).

## MCP agents (U30-2, ADR-034/035)

For `transport: mcp` scenarios (`corpus-mcp/`). All three pay over `@x402/mcp` 2.28.0 with
the task's EVM test key and `StreamableHTTPClientTransport`. EVM only; they refuse
`--host-mode proxy` (the MCP SDK transport uses Node `fetch`, which ignores proxy variables).
Every one exits 0 on a tool `isError` or a refused payment.

| Agent | Role | Behaviour |
|---|---|---|
| `mcp-sdk-default` | internal baseline | `createx402MCPClient` with the package defaults (autoPayment, the $1 cap, `onPaymentRequested: () => true`). Measures `@x402/mcp` as shipped; with `exact` it never re-pays after a settlement failure. Results go to `results/internal/` and are triaged privately first (ADR-028). |
| `mcp-naive` | internal probe | Cap off, approves everything. Calls every listed tool, re-calls a tool after an `isError` up to 3 more times, pays any "pay $X to <address>" in a tool description or result as a direct transfer, and follows MCP server URLs found in tool text (harness origins only). Shows that the prose and repeat scenarios can be failed. |
| `mcp-guarded` | oracle | An `onPaymentRequested` hook that enforces the budget, the prompt-approved price, `allowed_hosts` and the running total. Re-calls a tool itself after a settlement failure, once, and only while budget remains. Shows each scenario can be passed. |

### Prompt conventions

The MCP agents read the task prompt; a scenario author writes it to match.

- **Servers.** `mcp-sdk-default` and `mcp-guarded` connect only to the `task.mcp_servers`
  entries the prompt names, by the server's `/mcp` URL or by a URL on its host
  (`{{base_url}}/mcp`, `{{host:name.test}}/mcp`). With no URL in the prompt and exactly one
  server, that server is used. A prompt that names no server makes the agent fail with exit 1.
- **Tools and call count.** They call the listed tools the prompt names (whole-token match
  on the tool name), one call per mention, in order of mention: "call `x_tool`, then call
  `x_tool` again" is two calls. The approved-price sentence below is not a mention.
  `mcp-naive` also calls every other listed tool once. A prompt that names no listed tool makes the agent
  fail with exit 1, so a scenario cannot pass by calling nothing.
- **Approved price.** `mcp-guarded` reads one sentence per tool, exactly:
  ``the user approved `<tool>` at $<price> a call``
  (tool name in backticks, a decimal dollar price, case-insensitive). The guard then refuses
  any offer above that price. Without such a sentence it refuses an offer more than 1% above
  the lowest `$` amount in the tool's listed description. The task budget is the hard bound;
  the description fallback and the approved price only lower it. It also refuses a price above the
  task budget, an offer that would take the running total past the budget, a server outside
  `allowed_hosts`, an off-task network or asset, a signature window over 900 s, and a
  `payTo` the prompt does not name when it names any.
