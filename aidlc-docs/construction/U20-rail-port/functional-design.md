# U20 — Rail port (x402v2 behind a `Rail`; MPP-shaped seams) · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 6 **Phase B2** (parallel with U21) · Contract: ADR-014 (full)

## 1. Goal
All x402 wire knowledge leaves `routes.ts` and `challenge.ts` and moves into `rails/x402v2.ts` behind the `Rail` interface. **Behaviour is preserved byte for byte.** The interface is shaped for MPP, but MPP is not implemented:
- several challenges per 402;
- rail-owned header names;
- a challenge-binding check;
- receipts.

## 2. Files (owned in Phase B2)
```
packages/adversary/src/rails/rail.ts      NEW interface Rail, IssueCtx, RawCredential, SettleCtx, BindingResult (ADR-014 §1)
packages/adversary/src/rails/x402v2.ts    NEW: everything x402 from challenge.ts + routes.ts (PAYMENT-REQUIRED/-SIGNATURE/-RESPONSE, X-PAYMENT read fallback,
                                          buildPaymentRequired/buildRequirementsList, accepted-echo binding)
packages/adversary/src/rails/index.ts     NEW registry: railFor(scenario.rail) — "x402v1"/"mpp" → throw NotImplementedRail (load-time error with scenario id)
packages/adversary/src/challenge.ts       thin: delegates to the rail (or delete and update imports)
packages/adversary/src/routes.ts          serveChallenge uses rail.issue / rail.extract / rail.decode / rail.settle only; no @x402/* imports remain
packages/adversary/src/facilitator.ts     unchanged API; imports x402 types from rails/x402v2.ts if needed
packages/adversary/test/rails/*.test.ts   NEW, plus the existing adversary tests unchanged and green
packages/adversary/test/rails/fake-rail.test.ts  NEW: a test-only MPP-SHAPED fake rail (WWW-Authenticate: Payment id=…, request=b64url JSON;
                                          Authorization: Payment <b64url {challenge, payload}>; two challenges per 402) driving routes.ts end to end
                                          with a hand-built credential → proves the seams, without any MPP dependency
aidlc-docs is NOT in scope (the architect owns the MPP runway text)
```

## 3. Rules
- Binding: the x402v2 `decode` compares the payload's `accepted` (or v1 equivalents) to the issued accepts.
  - A mismatch sets `invalid_reason: "challenge_mismatch"` and the route does not deliver.
  - **Check first** whether today's code already rejects a mismatched accept by another path. If so, keep that same outcome and only add the reason code. Record any outcome difference as a deviation; never change it silently.
- `grep -rn "@x402/" packages/adversary/src --include=*.ts` must list only `rails/x402v2.ts`, `facilitator.ts` and `solana-rpc.ts`/`evm-rpc.ts` (where a type is needed).
- Rail identity is recorded in `IssuedChallenge.rail` ("x402v2").

## 4. Acceptance tests
**Developer (each < 2 min):**
- `pnpm -F @x402-redteam/adversary test`, which includes the ADR-007 real-SDK integration tests (unchanged and green);
- the fake-rail test;
- the grep rule above;
- the `challenge_mismatch` unit test.

**Orchestrator only:** naive and guarded `report.json` are **byte-identical** (minus timing) before and after U20, compared against main at merge-base. Then `pnpm test:e2e`.

## 5. Do not
- Add `mppx` or any dependency (a user decision; Bolt 7).
- Implement x402v1 or MPP rails.
- Open the `Category` enum.
- Touch `hosts.ts` or `proxy.ts` (U17), `record.ts` (U21), capture, the scorer or the corpus.
- Run E2E.
- Commit, except the single worktree commit.
