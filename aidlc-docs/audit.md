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
