# Architecture Decision Records

## ADR-001 Capture at the signer and the HTTP header, not the chain
**Decision:** Mode A decodes `PAYMENT-SIGNATURE` headers at the adversary server and, optionally, receives signer-shim events. A mock facilitator settles everything.
**Why:** It is deterministic, free and offline, and header capture works for agents written in any language.
**Cost:** It cannot see on-chain enforcement (SPL delegations, smart-account limits), so Mode B (ADR-006) exists for that.

## ADR-002 The agent points at the harness; there is no HTTPS proxy
**Decision:** The task gives the agent a `base_url`. Virtual hosts are path-prefixed (`/_host/<name>/…`).
**Why:** No CA install is needed and it works for any language or framework.
**Cost:** It misses agents that ignore the base URL and browse the open web. Hosts appear as path prefixes rather than real DNS names, so lookalike-domain attacks are judged by the host label. That is acceptable for v1; a proxy mode is noted for later.

## ADR-003 Scenarios in YAML, with multi-route instead of scripting
**Decision:** Declarative YAML with routes, behaviours and templated canaries. There is no scripting escape hatch until a scenario actually needs one.
**Why:** Guardrail authors can contribute by PR, and that is the distribution channel.
**Cost:** Complex stateful attacks wait for a later `behaviour` or script hook.

## ADR-004 Deterministic canaries for attribution
**Decision:** Every recipient in a scenario is a seed-derived canary that is unique to its channel (header vs prose), so `instruction_source` can be decided by matching values.
**Why:** It answers "why did it pay" without instrumenting the agent.
**Cost:** A scenario author must never reuse the same canary in both a challenge and prose. `validate` enforces this.

## ADR-005 Never run customer agents on our infrastructure
**Decision:** Customers run the harness locally or in their own CI and send `report.json` plus the ledger for an audit.
**Why:** It removes the sandboxing problem, the liability and the infra cost.

## ADR-006 Mode B deferred to a stretch bolt
**Decision:** Local validators (anvil / solana-test-validator) are opt-in and built last.
**Why:** Neither tool is installed, and Mode A covers every attack category that does not involve on-chain enforcement.

## ADR-007 Both chains from day one, driven through the real SDK clients
**Decision:** Integration tests use the real `@x402/evm` and `@x402/svm` clients against the harness. The harness serves a mock Solana RPC because the SVM client fetches a blockhash and the mint.
**Why:** It catches SDK drift early; the SDK READMEs already lag the source.
**Cost:** Dependency versions are pinned exactly and bumped deliberately.

## ADR-008 Reference agents are deterministic and LLM-free
**Decision:** `naive` and `guarded` are scripted. The LLM example is optional and never runs in CI.
**Why:** They make NFR1 (determinism) and the "fail everything / pass everything" E2E oracle possible.

## Risks
| Risk | Mitigation |
|---|---|
| Coinbase ships a test suite in the x402 SDK, and the corpus becomes a community contribution rather than a product | Ship the leaderboard early; the moat is corpus quality and the leaderboard's reputation |
| x402 SDK churn (v2.28 → next) | Exact pins; the ADR-007 integration tests fail loudly |
| Solana client needs RPC methods the mock doesn't cover | U2 must drive the real client, and unknown methods are logged |
| LLM agents are non-deterministic | `--repeat N` with worst-case scoring and a reported pass_rate |
