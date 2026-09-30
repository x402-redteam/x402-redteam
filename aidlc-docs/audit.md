# Audit Log (append-only)

## 2026-09-30 — Inception
- **User input:** "let's create this system design … have opus be the agent orchestrator and sonnet the lead developer. similar to the aidlc. use /engineering:system-design and /plan. ask questions" (+ pasted design draft)
- **Decisions (user):** deliver design+plan+build; gates per phase; both EVM and Solana from day one; repo ~/git/x402-redteam; AI-DLC-style lightweight (not the installed aidlc 2.8.2 engine).
- **Research:** x402 v2 spec + @x402/* 2.28.0 exports verified (headers PAYMENT-REQUIRED/PAYMENT-SIGNATURE/PAYMENT-RESPONSE; @x402/core/http encode/decode helpers; SVM client calls Solana RPC → mock RPC required).
- **Artifacts:** inception/requirements.md, inception/application-design.md, inception/units-of-work.md, inception/adr/decisions.md.
- **Gate G0:** awaiting approval.
- **Gate G0:** APPROVED by user ("Approve, start Bolt 1").

## 2026-09-30 — Bolt 1 (U1)
- Opus wrote construction/U1-schema/functional-design.md; Sonnet implemented.
- Deviations accepted: pnpm 10.34.6 via corepack (7.14.2 broken on Node 20); @types/node added; sync SVM key derivation via node:crypto; recursive loadCorpus; lint rule 3 as scenario-wide intersection.
- Review round 1 fixes: challenge.description + delivered_body templated; SVM secret = base58 64-byte keypair (kit round-trip test); JSDoc on formats.
- Opus contract amendment: capture-api DecodeHints + to_token_account (SVM ATA→owner), per U3 design §0.
- Verification (Opus re-run): lint clean, typecheck clean, 32/32 tests.
- Bolt 2 designs written: U2 adversary, U3 capture, U4 scorer.
- **Gate G1:** awaiting approval.
- **Gate G1:** APPROVED by user ("Approve, launch Bolt 2"). Bolt 2 launched: U2/U3/U4 Sonnet agents in worktrees.
- Opus: added `challenge.per_chain` + `challengeForChain()` to schema (rail-switch needs per-chain network/asset); biome ignores .claude/ worktrees. Bolt 3 designs (U5, U6) written.
- U4 merged (c990ccd). Deviations accepted: biome override for vendored SARIF schema; ajv named import; too_many_payments only when allow; SuiteMeta = {harness_version, agent_id, guardrail_id}. Opus review fix: USD shown with up to 6 decimals (formatUsd) so sub-cent price-bait payments aren't rendered "$0.00". 86/86 tests.
- U3 merged (1e9a023). Deps: @solana-program/token 0.17.0, token-2022 0.19.0.
- **SDK finding:** `registerExactSvmScheme` in @x402/svm@2.28.0 drops `schemeOptions`/rpcUrl (always `new ExactSvmScheme(config.signer)`); verified in source. Agents must `client.register("solana:*", new ExactSvmScheme(signer, {rpcUrl}))`. Candidate upstream issue (not filed).
- Decisions on U3 open points: v1 EVM falls back to chain-default domain (accepted); direct transfers use scheme "transfer" (accepted); `no_transfer_instruction` reason accepted; prose attribution matches `to` only — application-design §4 updated. Opus hoisted `FIXED_BLOCKHASH` into schema/chains.ts; capture uses it. 113/113 tests.
- U2 merged (db4a7b4). Real @x402/svm client needs exactly `getAccountInfo` (mint) + `getLatestBlockhash`; mock serves superset. biome `includes` removed (it matched zero files inside worktrees, whose paths contain .claude/); .gitignore covers .claude/.
- Decision on merge() collapsing identical header resubmissions: INTENDED — the same EIP-3009 authorization / Solana message can settle at most once, so it is one payment. The replay category is measured via re-issued challenges paid with new nonces (attribution exhaustion rule).
- **G2 integration (Opus):** adversary integration suite runs against both stub and real capture, on both chains, with the real @x402 clients, offline. Workspace: lint clean (86 files), typecheck clean, 145/145 tests. Worktrees removed.
- **Gate G2:** awaiting approval.
- **Gate G2:** APPROVED by user. Bolt 3 launched (U5, U6 in worktrees). U7 design written.
- U6 merged (06cf394): 10 scenarios × 2 chains; corpus-smoke test serves every route on a live adversary.
- Opus review fix: template `{{host:NAME}}` now accepts dots and any unrendered `{{…}}` throws (U6 found dotted hosts silently leaked the literal template). Corpus hosts restored to realistic dotted names (cdn-metrics.test, billing-provider.test, weather-report.test, weather-rep0rt.test). 171/171 tests.
- Risk carried to U5: naive must re-fetch on 402_forever / empty no_delivery body so retry-storm and fake-delivery actually produce a 2nd payment.
- U5 merged (61b73e2). Accepted: capture/attribute excludes a payment's own shim twin from `prior` (dual capture had marked every shimmed payment as replay); naive disables x402Client default `spendControls.maxAmountPerPayment` ($1) — note: the SDK ships a built-in $1 per-payment cap, relevant to audits; SVM registered on `solana:*`.
- Opus review fixes: (1) mock Solana RPC serves a 6-decimal mint for every asset named by the loaded challenges, so rail-switch/svm tests the agent's policy instead of failing inside the SDK; (2) report.json omits per-payment `raw` and `dedupe_key` (agent-chosen random EIP-3009 nonces) — full ledger stays in out/runs/<run_id>.json — restoring NFR1.
- **G3 E2E (Opus, real corpus, 10 scenarios × 2 chains):** naive exit 1, 0/20 runs pass, 76 payments (74 header, 2 prose); guarded exit 0, 20/20 pass, $0 unauthorized; each full run ≈14 s (NFR3 < 5 min); two naive runs → identical report.json minus timing (sha e61d8f0…). 188/188 tests, lint + typecheck clean.
- Polish noted for Bolt 4: unit-confusion's ~$4e12 dominates the headline unauthorized $; consider thousands separators / a per-category view in the README.
- **Gate G3:** awaiting approval.
- **Gate G3:** APPROVED by user (Bolt 4 without Mode B). U8 moved to roadmap [S]. U7 launched (+ formatUsd thousands separators, seeded leaderboard results).
