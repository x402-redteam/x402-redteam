# U21 — Capture lows from the U10 re-review (SetAuthority value; plain SPL Transfer asset) · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 6 **Phase B2** (small; parallel with U20) · Contract: ADR-016 §4

## 1. Goal
"Every dollar" holds for two SVM instruction shapes that are currently under-reported:
- `SetAuthority` over a known token account is recorded at $0 today (`capture/src/svm.ts:330-362`);
- a legacy `Transfer` has `asset: ""` (`svm.ts:193-232`), so it falls back to $1 per 6-decimal unit.

## 2. Files (owned in Phase B2)
```
packages/capture/src/svm.ts        Transfer: if source token account ∈ hints.knownTokenAccounts → asset = its mint, from = its owner (authority still verified);
                                   destination ∈ knownTokenAccounts → to = owner. SetAuthority with authorityType AccountOwner or CloseAccount over a
                                   known token account → scheme "approve", asset = mint, amount_atomic = MODELLED balance marker (see §3)
packages/adversary/src/record.ts   build knownTokenAccounts: the agent's ATA for every known SVM mint (KNOWN_ASSETS + scenario.assets) and the canary owners' ATAs;
                                   for SetAuthority legs, amount_usd = walletBalanceUsd(task) (then the existing approve cap applies)
packages/capture/test/svm-*.test.ts, packages/adversary/test/record.test.ts
```

## 3. Rules
- The decoder stays pure: it marks a full-balance grant with `amount_atomic: "0"` plus `authority_grant: true` in the decoded leg.
  - The `DecodedPayment.authority_grant` field is landed by U15.
  - `record.ts` values the grant at the modelled balance.
- AuthorityType `MintTokens` / `FreezeAccount` → still $0, recorded.
- Unknown token accounts behave exactly as today.

## 4. Acceptance tests (developer, each < 1 min)
- A SetAuthority (AccountOwner) on the agent's USDC ATA to a canary is recorded as `approve`, amount = `wallet_balance_usd`, `asset_known: true`, and fails a scenario that disallows payment.
- A plain `Transfer` from the agent's USDC ATA of 2_000_000 → asset = USDC mint, $2.00, `asset_known: true`.
- A plain `Transfer` from an unknown account → unchanged (`asset: ""`, `asset_known: false`).
- `pnpm -F @x402-redteam/capture test` and `pnpm -F @x402-redteam/adversary test` are green.

## 5. Do not
- Touch `routes.ts`, `challenge.ts` or `rails/` (U20), the scorer, or the corpus.
- Add scenarios. A SetAuthority attack scenario is a U23 candidate.
- Commit, except the single worktree commit.
