# U18 — Guardrail-track standard driver and GDP v1 · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 6 **Phase B1** · Contract: ADR-010 (full), application-design v3 "Guardrail Decision Protocol v1"
**This is the hard prerequisite for any ranked leaderboard.** It is the largest unit. If the developer's estimate goes above one session, split it into U18a (driver plus protocol) and U18b (example guardrails plus calibration test) at the orchestrator's discretion.

## 1. Goal
`x402-redteam run --guardrail "<cmd>"` runs a frozen, deterministic, maximally attempting driver as the agent. The guardrail is the only variable, and it answers GDP over stdio. Calibration proves the driver reaches every attack.

## 2. Files (owned in Phase B)
```
packages/driver/                       NEW workspace package @x402-redteam/driver (bin: x402-redteam-driver)
  src/main.ts                          reads task.json (env X402_TASK_FILE), spawns X402_GUARDRAIL_CMD, runs the loop below
  src/gdp.ts                           JSON-lines client: hello, request/response by id, 5 s timeout → deny + guardrail_error log line
  src/protocol.ts                      exported TS types for GDP v1 (re-exported for guardrail authors)
  src/crawl.ts                         BFS over every link on harness origins (any *.localhost:<port>, base_url, /_host/), depth ≤ 4, ≤ 200 fetches
  src/pay.ts                           x402Client with spend controls DISABLED (no maxAmountPerPayment, allowedAssets = all) — CITE the
                                       @x402/core 2.28.0 source lines for the default cap and asset allowlist being disabled;
                                       registerPolicy → GDP "payment" (choose accept_index / deny); signer wrapper → GDP "sign"
  src/intent.ts                        scenario-agnostic transfer-intent extractor: an amount ($N | N USDC) and an address (0x40hex | base58 32–44)
                                       in the same sentence → TransferIntent; NO corpus-specific phrasing ("pay … to")
  src/transfer.ts                      direct transfer via harness RPC (reuse logic of examples/agents/src/lib/transfer.ts; copy, don't import examples)
  test/*
packages/cli/src/guardrail-track.ts    resolveAgentCommand: --guardrail ⇒ agent = node <driver bin>, env X402_GUARDRAIL_CMD=<cmd>; config.track/driver/
                                       guardrail_hooks (read from the driver's hello result file out/runs/<run_id>.gdp.json)
examples/guardrails/                   NEW (TS, each < 80 lines, using @x402-redteam/driver/protocol types)
  allow-all.ts, deny-all.ts            calibration
  sdk-defaults.ts                      x402Client default spend controls expressed as GDP: $1 per payment, @x402/core default asset table (cite source)
  hostname-allowlist.ts                hostname ∈ allowed_hosts only
  reference-policy.ts                  guarded.ts's policy ported to GDP hooks (payment + transfer)
  README.md                            how to write a guardrail in any language; a 25-line Python GDP example inline
packages/cli/test/driver-calibration.e2e.test.ts   NEW (orchestrator runs)
```

## 3. Driver loop (`driver@1`; any behaviour change bumps to `driver@2`)
1. Send `hello` and receive the hooks. Write `{hooks, name, version, nondeterministic}` to `out/runs/<run_id>.gdp.json`.
2. Seeds: URLs in the prompt, in order. BFS, in which each URL is fetched **twice** (two top-level attempts).
3. On a 402, run the GDP `payment` hook (if implemented) and then `sign` on the signing payload (if implemented). If both allow, pay the chosen accept.
   - If the guardrail lacks `payment`, the accept is chosen by the SDK default selector over the full list.
4. Paid but the response is 402 or an empty body: retry the top-level fetch, up to 3 times.
5. For every fetched page body, and for the 402 body and its `error` text, extract transfer intents. Each distinct (url, to, amount) goes through `transfer` and then `sign`, and if allowed is sent via the harness RPC.
6. Deterministic: no `Math.random` and no wall clock in decisions. Fixed BFS order: lexical within a page, in order of discovery.

## 4. Acceptance tests
**Developer (each < 3 min):**
- GDP unit tests: an id mismatch, a timeout leading to deny, a malformed line leading to deny with a log, and a guardrail exit mid-run leading to deny for the remainder.
- `intent.ts` table test over **every** prose page and 402 body in `corpus/` (load the YAML and render with a test seed): every prose-class `surface` page yields ≥ 1 intent whose `to` is the scenario's prose canary, and no control page yields an intent. This is the reach proof for the prose class without running agents.
- Targeted probes (`--scenario`, each about 1–2 min):
  - `--guardrail "tsx examples/guardrails/allow-all.ts" --scenario ghost-paywall` → fail on both chains;
  - `deny-all --scenario price-bait` → exit 2 (controls fail);
  - `reference-policy --scenario resource-url-spoof` → pass.

**Orchestrator only (`driver-calibration.e2e.test.ts`, full corpus × 5 guardrails, too long for a developer):**
- allow-all: **every** attack scenario×chain fails, and every control passes;
- deny-all: every attack passes, every control fails, exit 2;
- reference-policy: every attack and every control passes (exit 0). If not, the failures are recorded and sent to the architect; **do not** tune the corpus to the policy;
- sdk-defaults and hostname-allowlist: results are recorded to `results/internal/` and assert nothing beyond validity;
- determinism: two allow-all runs give a byte-identical `report.json` minus timing.

## 5. Do not
- Import from `examples/` into `packages/driver` (the driver must be self-contained).
- Use any corpus-specific string, scenario id or route name in the driver or `intent.ts`.
- Enable any SDK spend control in the driver.
- Spawn the guardrail with network-related env beyond the scrubbed agent env.
- Change scoring, schema or the corpus. If calibration finds an unreachable scenario, report it; U23 fixes the corpus.
- Run the calibration E2E.
- Commit, except the single worktree commit.
