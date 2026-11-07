# Architecture review — U37 functional design rev 1 (capture fixes, M1/M2)

Reviewer: senior architect (read-only). Inputs: `construction/U37-capture-fixes/functional-design.md`
(rev 1, 313 lines), `reviews/consulting-architecture-review.md` rows M1/M2, ADR-009, ADR-013 and
the U29-0 N4 note (`inception/adr/decisions.md:213`), `packages/capture/src/{evm,evm-signatures,
merge,attribute,index}.ts`, `packages/adversary/src/{facilitator,record,credential,mcp-server,
rails/x402v2}.ts`, `packages/scorer/src/{score-run,score-suite,types}.ts`,
`packages/leaderboard/src/build-leaderboard.ts` (re-score), `packages/fuzz/src/diff.ts`,
`corpus/controls/*`, `corpus-mcp/*`, `corpus/replay.yaml`. Checkout: main 47c5129.

## Verdict: READY WITH CONDITIONS (rev 2 for C1–C2, then build). 0 Blocking, 2 Major, 8 Minor.

The diagnosis is right and every cited line checks out. Dropping network and asset from the key
is safe: the signature binds both, and an identical signature resent with another echoed
network merges, as it should. The predicted no-change holds against the committed data. Two
Majors in M2, both small fixes: the `transfer` exemption reads a client-echoed `scheme`, so
the rule can be bypassed, and `merge()` lets a hint-less facilitator capture overwrite the
offered reading, so an honest client can fail the gate. The owner recommendations are all
endorsed.

## 1. Verified facts
- Every key site in §2.1–2.2 checks out: `evm.ts:287` (header EIP-3009 `evm:${nonce}`),
  `evm-signatures.ts:180` (shim EIP-3009), `:209` (Permit2, shared by header and shim),
  `evm.ts:639` (RPC `transferWithAuthorization`), `evm-signatures.ts:493` (7702),
  `:283` (unknown typed data, no signature), `evm.ts:495` (`evm:unknown`), `allowanceKey`
  `:148-158` already ends in `keccak256(signature)`. `merge.ts:44-61` merges on key alone. OK.
- §2.5: `valid` = client copy (`evm.ts:326-328`); `terms_verified` from `hints.offeredTerms`
  (`:307-315`); offered terms built only in `rails/x402v2.ts:457-468` from
  `currentChallengeIds`. Stripped at `score-suite.ts:536`, `types.ts:389`. Control test
  `score-run.ts:397-408`. OK.
- Leaderboard re-score (`build-leaderboard.ts:886-897`) parses runs through `RunRecordSchema`,
  which already has `terms_verified` optional (`schema/src/ledger.ts:159`), and fills
  `dedupe_key` with `payment_id`; so persisting the field reaches the re-score. OK.
- Held-out guard (`scripts/heldout-guard.mjs --message-file`) over the design: clean. The
  design names only public controls. OK.
- §7 counts match the committed files (scripted scan of `results/*.json`, `results/mcp/*`,
  `results/internal/*`): guarded 123 `header+shim`; naive 472 `header+shim`, 6 `rpc+shim`,
  3 `shim+submitted`. Every **control** payment leg in all seven results is `scheme: exact`
  (or `approve` grants) captured `header` or `header+shim`; none is `rpc`, shim-only,
  `submitted` or `route_key: facilitator`. So the fail-closed rule meets no exempt-path or
  absent-field case in the references. OK.
- Every control uses default `extra` (`x402v2.ts:66` merges `CHAIN_DEFAULTS.extra` under the
  scenario's) and none uses `wire:`. OK.

## 2. M1 key shape (focus 1)
- **Dropping network and asset is safe.** For EIP-3009 the digest binds `chainId` and
  `verifyingContract`; for Permit2 it binds `chainId` (domain) and `permitted.token`
  (message). Two genuinely distinct authorizations that differ only in chain or token have
  different digests, so different signatures (a collision needs a secp256k1 or keccak break).
  The EIP-3009 per-token nonce space therefore cannot produce a false merge under the new key.
- **The identical signature resent with a different echoed `accepted.network`/`asset`**
  keeps one key and merges. That is the right answer: one signature verifies on at most one
  domain, so at most one transfer can ever settle. It is also today's behaviour (nonce-only),
  so nothing moves. The merged entry keeps the first header's fields (current wins ties).
- **Unsigned or garbled payloads** (`nosig`/`badsig`) that differ only in network/asset would
  merge. Both are `valid: false`; the only effect is one ledger entry instead of two. Accept.
- **Bonus fix:** EIP-3009 and Permit2 used to share the `evm:<nonce>` namespace; the new
  `eip3009:` / `permit2:` prefixes separate them.
- **Parity is achievable** for header+shim (both EOA paths sign identical bytes; Permit2
  header and shim already share `permit2TransferLeg`) and header+RPC (RPC only decodes the
  `(v,r,s)` overload, `evm.ts:53-62,627-641`, so 27/28 rebuilds the same 65 bytes). EIP-3009
  header (`decodeEip3009`) and shim (`eip3009Leg`) are **different functions**, so parity
  depends on one shared key builder (Minor m1). Smart-wallet bytes have parity header↔shim
  only (identical bytes); the RPC layer never sees them (no `bytes` overload decoded).
- **"Equal keys with different chain/from/to/amount are appended"**: correct as an assertion
  (it cannot fire for a well-formed key, since from/to/value are in the key). But appending
  a second entry with the *same* `dedupe_key` breaks the key-uniqueness every consumer
  assumes (Minor m3).

## 3. Replay and nonce reuse (focus 2)
- **Genuine replay kept.** The `replay` attacks (`corpus/replay.yaml`, `replay/replay-2,-3`)
  elicit a *fresh* authorization against a re-issued identical challenge; that is detected by
  challenge claiming in `attribute.ts:60-87`, not by the key (acceptance test
  `adversary/test/acceptance-suite.ts:170-173` asserts distinct keys and `replay: true`).
  Random nonces keep those keys distinct under both schemes. Unchanged.
- **Identical resend.** Same bytes → same key → merged, exactly as today. Note the merged
  ledger entry keeps `replay: false`: on equal rank the existing entry is primary
  (`merge.ts:48-58`), so the incoming capture's `replay: true` from `attribute.ts:101` does not
  survive. AC-3 claims "`replay: true` on the second capture"; that is not today's ledger
  behaviour (Minor m4).
- **Nonce reuse, different payee or amount.** Now two entries; the second does not match the
  claimed challenge (`attribute.ts:52-59` needs payTo and amount equality) and is scored on
  its merits (`wrong_recipient`, `too_many_payments`, budget). Correct, and it is the M1 fix.
- **No corpus scenario depends on nonce-only merging.** `nonce` appears in the corpus only in
  replay prose, the authorization-lifetime prose and `signature-request-2` (a typed-data
  request with `nonce: "0"`, whose shim and `submitted` captures carry the same signature and
  still merge). `evm-rpc.ts:107-123` parses only Permit (allowance) keys, which are unchanged.

## 4. M2 control rule (focus 3)
- **Fail-closed on EVM authorizations: right.** An EIP-3009 or Permit2 signature is the
  payment; only one over the offered domain, payee and amount settles. Absent = not offered
  is the correct default, and reusing `required_payment_missing` avoids an enum bump.
- **The exemption is keyed on a client-controlled field (Major M-A).** §4.1 exempts
  `scheme === "transfer"`. On the header path `scheme` is the client's echo:
  `decodeEip3009` sets `scheme: accepted.scheme` (`evm.ts:282`), `decodePermit2` likewise
  (`evm.ts:369`), and v1 takes `payload.scheme` (`evm.ts:471`). Dispatch is by payload shape
  (`evm.ts:478-481`), not by scheme. The binding check records
  `binding_mismatch` (`record.ts:132`) but the scorer never reads it. So a client whose copy
  says `scheme: "transfer"` is exempt and earns control credit for an authorization signed
  over its own copy: the exact class M2 exists to close. The exemption must rest on what
  capture observed, not on what the client echoed.
- **Merge can overwrite the offered reading (Major M-B).** `merge()` takes every field from
  the higher-ranked side, and ties go to the existing entry. `/facilitator/verify`
  (`facilitator.ts:56-72`) decodes **without** `offeredTerms` and records the leg as
  `capture: "header"`, `route_key: "facilitator"`; its EIP-3009 reading is therefore
  `client_copy`. The facilitator URL is exported to every agent (`cli/src/run.ts:216`,
  `task.json.facilitator_url`). An honest agent or SDK that pre-verifies through the
  facilitator before sending the header gets a merged entry whose primary is the facilitator
  leg, so `terms_verified: "client_copy"`, and fails `control-paid-fetch`: `valid: false` for
  an honest client. None of the seven references does this (§1 scan), so §7 still holds, but
  the design's "no honest reference marked invalid" claim needs the merge to be
  reading-aware. The same hazard applies to any future layer of equal rank without hints.
- **SVM exemption: sound.** The decoded message is what the chain executes; recipient,
  network (`disallowed_network`) and asset value (via `assetInfo`, so an unknown mint is $0
  and fails `amount_usd >= challenged`) are already checked by `checkPayment` /
  `challengedAmountUsd`. An EVM run that echoes a `solana:` network decodes as SVM, fails
  (`decode_error` or `disallowed_network`). OK.
- **Raw EVM tx exemption: sound for `transfer`/`transferFrom` calldata.** The RPC-only
  `transferWithAuthorization` leg is also `scheme: "transfer"` (`evm.ts:627-641`) and its inner
  authorization is never verified against the token domain; residual 4 records it. Keep it as a
  residual, but name it in the ADR-009 amendment as a known fail-open path, not just in §9.
- **Permit2 reading (§4.3): correct and necessary.** Without it both Permit2 controls fail for
  every agent. The four conditions (domain chainId from the term, token, recipient via
  `permit2TransferLeg`, amount, no untrusted spender) are the right ones. One gap: AC-8 should
  also cover the upto proxy (`X402_UPTO_PERMIT2_PROXY`, amount is a ceiling) so it is not
  silently `offered_domain_only` if a control ever uses it.
- **Offered terms are the route's current issuance only** (`x402v2.ts:457-459`, per-route
  `state.ts:13`). For controls this is fine (terms are stable across issuances of a route,
  and `mcp-control-settle-fail`'s second payment answers the fresh challenge). Record it in
  §9: a control whose terms change between issuances would need the reading to consider
  every issuance of that route.

## 5. Persistence, re-score and the gate (focus 3, cont.)
- **Persisting `terms_verified` in `runs[].payments[]`: required and sufficient.** The
  re-score (`build-leaderboard.ts:886-897`) parses through `RunRecordSchema`, which keeps the
  optional enum (`ledger.ts:159`), so Tier 2 reproduces the verdict once `score-suite.ts:536`
  and `types.ts:389` stop dropping it. The value depends only on what was signed versus what
  was offered, so NFR1 holds for a deterministic agent.
- **Trust:** a Tier 2 submitter can edit `terms_verified` to `offered`, just as it can edit
  `valid` today. This is the existing ADR-011 "edited `runs[]`" residual, not a new one, but
  the ADR-009 amendment should say the field joins that list. Tier 1 is attested, not
  re-scored, and `report@4-redacted` drops `runs[]`; neither is affected.
- **Gate interaction (U36).** `control-paid-fetch` is the only gate in `corpus/`; every
  `corpus-mcp/` control has no `control_role` and so counts as a gate
  (`mcp-control-settle-fail` needs two offered payments). A client-copy-only payment on the
  gate now makes `valid: false` (exit 2, not rankable); on a battery control it lowers
  `utility` and `rank_score`. That is the intended consequence of M2 and AC-7 tests it. With
  M-B unfixed, the same path can invalidate an honest client; with M-A unfixed, a dishonest
  echo passes the gate.

## 6. Predicted no-change (focus 4)
Plausible, and better supported than §7 says. The committed data (§1) shows every control
payment leg is header-captured `exact`, so the new rule only ever meets EIP-3009/Permit2
legs that went through `x402v2.decodeObject` with offered terms; all seven agents echo
`accepted` unchanged and sign over default `extra`; header+shim parity is the one real risk
(123 + 472 + MCP merges), and AC-2 plus AC-10 catch it. Two refinements:
- AC-10 should say the added lines are on **attack** legs too (every header EIP-3009 and now
  Permit2 leg gains the field), so the scripted check must allow `terms_verified` on any EVM
  payment leg and nothing else.
- AC-11: Permit2 legs now get a reading, so the fuzz oracle
  `signature_not_over_offered_terms` (`diff.ts:294-295`) can newly fire on Permit2 fuzz cases.
  "Every changed case is explained by nonce reuse" is too narrow (Minor m6).

## 7. Schema (focus 5)
Riding in the unreleased `report@4` is right (Q1 (a)). `report@4` exists only as our own
committed results (CHANGELOG `[Unreleased]`, line 37: no allowlisted harness yields a rankable
`report@4`), the change is one optional field plus a stricter control rule, and the seven
references are regenerated in the same PR. A `report@5` that never ships alone would cost a
superseded-schema bucket and a season-pin edit for nothing. Condition: the CHANGELOG line
states that a pre-U37 `report@4` file re-scores with its EVM controls failing (so nobody
treats such a file as current).

## 8. U37b split, residuals, leakage (focus 6–7)
- **Split: agree.** HTTP `settle_fail` and slow-settle touch the scenario enum, lint, adversary
  timing, corpus hash and control count; folding them in would destroy U37's "only one field
  moves" check, which is the main safety net for M1 parity.
- **Residuals.** 1 (delivery on client copy), 3 (high-s), 4 (RPC-only tWA), 5 (no SVM
  reading), 6 (U37b) are accurate. Residual 2 says nonce reuse "over-states, never
  under-states" and calls that conservative; it is conservative for safety but can turn a
  budget-bound attack or a `total_usd` control into a false fail for an agent whose two
  signatures could never both settle. Say so (Minor m7). Add two: the client-echoed
  `scheme` (until M-A's fix lands) and current-issuance-only offered terms (§4 above).
- **Held-out leakage:** none. `heldout-guard.mjs --message-file` over the design is clean; it
  names only public controls (`control-paid-fetch`, `control-permit2-payment`,
  `control-permit2-gas-sponsored`, `control-replay-final-delivery`) and public mechanisms.
  The same must hold for the new fixtures (C9).

## 9. Findings

### Blocking
None.

### Major
- **M-A. The `transfer` exemption reads a client-echoed field.** Header `scheme` is
  `accepted.scheme` (`evm.ts:282, 369`; v1 `:471`), dispatch is by payload shape
  (`:478-481`), and the scorer ignores `binding_mismatch`. A client copy echoing
  `scheme: "transfer"` skips `termsQualify` and earns control (and gate) credit for an
  authorization a chain would reject. **Fix:** derive the exemption from what capture
  observed. Simplest form that needs no new field and survives the re-score: an EVM payment
  leg is exempt only when `scheme === "transfer"` **and** its `capture` label has no `header`
  layer (the header path never produces a raw-tx payment leg; the gas-sponsoring
  `signedTransaction` is an `approve` grant). Alternatively, have capture set `scheme` from
  the decoded artifact kind on the header path; that changes report bytes, so it is the
  heavier option. Add an AC: an EIP-3009 header with `accepted.scheme: "transfer"` signed over
  a client copy fails the control.
- **M-B. `merge()` lets a hint-less layer overwrite the offered reading.** `/facilitator/verify`
  (`facilitator.ts:56-72`) records a `header`-rank leg without `offeredTerms`; ties keep the
  existing entry (`merge.ts:48-58`). An honest client that calls the exported facilitator URL
  before sending its header ends with `terms_verified: "client_copy"` and fails the gate.
  **Fix:** (1, required) `merge()` takes the strongest reading across the two
  sides (`offered` > `offered_domain_only` > `client_copy` > `none` > absent), independent of
  layer rank; (2, recommended) the facilitator routes pass the offered terms of every route's current issuance in their hints, like
  `x402v2.decodeObject`. Add an AC: facilitator `/verify` then header, and header then
  `/verify`, both give `offered` and pass the control.
  (The facilitator leg also wins `route_key`/`challenge_id` today; that is pre-existing and
  out of scope, but worth a line in §9.)

### Minor
- **m1. One key builder per artifact.** EIP-3009 header (`decodeEip3009`), shim
  (`eip3009Leg`) and RPC (`decodeCalldataLeg`) build the key in three functions. Specify a
  single `eip3009Key({from,to,value,nonce,signature})` in `evm-util.ts`: addresses lowercased,
  value via `BigInt` to decimal (raw string kept when it does not parse), nonce lowercased
  0x-hex, then `sigKey`. Same for 7702 (shim and tx-embedded).
- **m2. `sigKey` canonicalisation.** Parse with viem `parseSignature` (handles 65-byte and
  64-byte EIP-2098 compact) and re-serialise as `r‖s‖(27+yParity)`; hash raw bytes only when
  parsing fails (ERC-1271/6492). As written, a compact header signature and its RPC `(v,r,s)`
  copy split into two payments. State that the 7702 shim signature and the tx-embedded
  `serializeSignature({r,s,yParity})` go through the same path. Add a compact case to AC-2.
- **m3. The merge guard must keep keys unique.** An appended twin with the same `dedupe_key`
  confuses every key-indexed consumer: later merges hit the first (`findIndex`),
  `attribute.ts:101` flags replays, `record.ts` `signedDeadlines`/`assignSubmissions`, and
  `fuzz/src/diff.ts:333` counts one. Append with a disambiguated key (`<key>#<seq>`) and compare
  amounts by `BigInt` (a header `value` in hex would otherwise fire the guard on a true twin).
- **m4. AC-3 describes a ledger state that does not exist.** An identical resend merges and the
  entry keeps `replay: false` (existing side wins the rank tie). Rewrite AC-3 as "identical
  resend: one entry, byte-identical to main's ledger; fresh authorization against a claimed
  challenge: `replay: true`, distinct keys (`acceptance-suite.ts:170-173` unchanged)".
- **m5. AC-8 upto proxy.** Add an upto-proxy Permit2 case (witness `facilitator`, amount a
  ceiling) so its reading is pinned, even though no control uses it today.
- **m6. AC-11 too narrow.** Permit2 readings can newly trigger `signature_not_over_offered_terms`
  in fuzz cases; allow "explained by nonce reuse **or** a new Permit2 reading".
- **m7. Residual wording and two additions.** Residual 2 can yield false fails on
  budget-bound scenarios; say so. Add: current-issuance-only offered terms; the facilitator
  leg winning `route_key` on ties.
- **m8. ADR-009 amendment content.** Name the RPC-only `transferWithAuthorization` path as a
  known fail-open of the control rule and add `terms_verified` to ADR-011's list of
  submitter-editable `runs[]` facts.

## 10. Owner questions
- **Q1 report version: (a), agree.** Nothing external holds `report@4`; add the C7 CHANGELOG line.
- **Q2 delivery on client copy: (a) now, (b) in U37b, agree.** Refusing delivery moves every
  attack transcript and `delivered`, which would mask an M1 parity bug in the U37 diff. In
  U37b, refuse only when the reading is not `offered` **and** no offered term verifies the
  domain, and reuse the MCP `settle_fail` response shape.
- **Q3 settle-fail / slow-settle: (a), agree.** U37b after U37 merges, its own corpus-hash and
  control-count change.
- **Q4 key fields: (a), agree**, conditional on m1/m2 (one normalising builder, parsed
  signatures). (b) adds two fields that every layer reads from a different source (client
  echo, signed domain, tx target), which is exactly where parity breaks; the signature already
  binds them.

## 11. Conditions (rev 2, then build)
- **C1 (M-A).** §4.1 exemption rests on capture-observed provenance (no `header` layer for a
  `transfer` leg, or capture-set scheme); AC for an echoed `scheme: "transfer"`.
- **C2 (M-B).** `merge()` keeps the strongest `terms_verified` across sides regardless of
  rank; facilitator decode passes offered terms (recommended); AC for both arrival orders.
- **C3 (m1, m2).** Single key builder per artifact in `evm-util.ts`; `sigKey` via
  `parseSignature`; AC-2 gains compact-signature and 7702 shim/tx cases.
- **C4 (m3).** Guard appends with a unique key and compares amounts numerically; AC-5 asserts
  key uniqueness of the result.
- **C5 (m4–m6).** Rewrite AC-3; add the upto case to AC-8; widen AC-11; AC-10 allows the field
  on any EVM payment leg (attacks too) and nothing else.
- **C6 (m7, m8).** §9 and the ADR-009 / ADR-011 amendments carry the added residuals.
- **C7.** CHANGELOG `[Unreleased]`: BREAKING control rule, dedupe-key change, and "a
  pre-U37 `report@4` file re-scores with EVM controls failing; regenerate it".
- **C8.** If AC-10 shows any figure other than the added field moving, stop and report (as
  §7 says); do not adjust the rule to restore a reference.
- **C9.** New fixtures use seed-derived keys and public ids only; run the held-out guard on
  the PR's added lines.

## Delta check rev 2

Rev 2 (423 lines) maps C1–C9 in §11; I checked each against the code. No Blocking or Major
findings remain. Every condition is met.

- **C1 (provenance exemption): met.** `capture` is set by the receiving endpoint
  (`recordDecodedLegs(..., {capture})` in the routes, MCP, facilitator, ledger, RPC and
  collect_signature handlers), never parsed from client data. The client picks the endpoint
  but cannot relabel a leg. A header-less dodge does not work for typed-data authorizations:
  shim and `submitted` legs take `scheme` from the decoded artifact (`eip3009Leg` and
  `permit2TransferLeg` hard-code `exact`; 7702 is `delegate`, a grant that never counts toward
  `min_payments`). So a shim-only or submitted EIP-3009/Permit2 leg falls in row 2 of §4.1,
  has no hints, so no reading, and fails closed. The only authorization that skips the rule
  is EIP-3009 inside a raw `transferWithAuthorization` tx (RPC or shim `evm_tx`). That is
  residual 4, now named in the ADR-009 amendment. Exploiting it needs a delivered header
  payment plus a separately self-relayed tx, so leaving it as a named residual is acceptable.
  AC-6 tests the exempt rows and the echoed-scheme header, but not row 2 directly (D1).
- **C2 (strongest reading, facilitator hints): met.** Strongest reading regardless of rank
  plus AC-5/AC-13 closes M-B in both orders. **The run-wide fallback is not a fail-open for
  controls.** Every term in it was offered by the harness, so a signature over any of them
  settles. The control test still needs `valid`, no `wrong_recipient`/`disallowed_network`
  against the scenario's `expected`, and `amount_usd >= max_usd`. A control run's challenges
  are all honest terms from that control. The widening only shows up in the ledger: via
  strongest-reading merge, a facilitator reading over another route's (or a stale) issuance
  can upgrade a route leg's `offered_domain_only` to `offered`. That can hide fuzz
  `signature_not_over_offered_terms` on a client that also calls `/verify`. The fallback is
  also unnecessary: `RunState.routeRuntimes` (`state.ts:50`) is in-package and only needs a
  getter (D2).
- **C3 (nonce forms): met.** EIP-3009's bytes32 nonce is lowercased 0x-hex. The RPC decode
  yields 32-byte lowercase `Hex` and the SDK header nonce is the same, so they match.
  Permit2 and 7702 uint nonces go through `BigInt` to decimal (header decimal string, shim
  bigint, 7702 number), so they match too. A non-32-byte header nonce cannot verify as
  bytes32, so splitting it from other layers is harmless. `parseSignature` covers compact
  signatures and AC-2 pins them.
- **C4 (`<key>#<seq>`): met.** `seq` is unique per run, so the suffix is unique. It cannot
  clash with `svm:…#<ix>` or `evmtx:…#approve`, because those are whole keys and the suffix
  only extends one.
- **C5–C9: met** as mapped in §11 (AC-3 rewritten, upto case, AC-10/11 widened, residuals 2/7/8,
  ADR-009/011/013 amendments, CHANGELOG lines, stop rule, fixture hygiene and held-out guard).

**D-conditions (fold into the build, no rev 3 needed)**
- **D1.** AC-6 adds a control whose only payment is a shim-only (and, separately, a
  `submitted`) EIP-3009 typed-data leg, valid with no header: it must fail. This pins
  row 2 of §4.1.
- **D2.** The facilitator builds offered terms from the union of every route's
  `currentChallengeIds` (add a getter on `RunState`), using the same helper as
  `x402v2.decodeObject`. Drop the "every challenge issued in the run" fallback, so
  facilitator and route readings follow one rule.

## Verdict (rev 2): SIGNED OFF FOR BUILD, with D1–D2.
