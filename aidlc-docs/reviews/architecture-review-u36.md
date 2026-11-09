# Architecture review — U36 functional design rev 1 (scoring credibility)

Reviewer: senior architect (read-only). Inputs: `construction/U36-scoring-credibility/functional-design.md`
(rev 1, 293 lines), `packages/scorer/src/{score-suite,score-run,wilson,redact,types}.ts`,
`packages/leaderboard/src/{build-leaderboard,canonical,main}.ts`, `packages/cli/src/{run,guardrail-track}.ts`,
`packages/fuzz/src/diff.ts`, `corpus/price-bait.yaml`, `corpus/price_bait/*`,
`corpus/recipient_redirect/address-poisoning*.yaml`, `corpus/controls/*`, `corpus-mcp/`,
`LEADERBOARD.md`, `docs/seasons.md`, `README.md` "Versioning", test pins under `packages/*/test`.

## Verdict: READY WITH CONDITIONS (rev 2 for M1–M7, then build). 0 Blocker, 7 Major, 10 Minor.

The split is right and the diagnosis is right: refusal buys safety today, utility does not rank,
and nothing checks the determinism claim. Every verified fact in §2 checks out against this
checkout. But rev 1 has seven Majors. AC-a4 cannot pass as written. The gate/battery line is
drawn through two controls that are already category mirrors. §5.1 claims `checkRescore` covers
the new fields, but the Tier 1 path is never re-scored. The `report@4` consumer list is
incomplete. U36-c's repeat check is easy to satisfy without being deterministic. The Wilson
interval uses the wrong n and the wrong statistic. Attempt-mean semantics are not defined for the
existing pass fields. No blockers: each fix is a rev 2 text change plus tests.

## 1. Verified facts (focus 1)
- 71 YAML = 64 attacks + 7 controls; 56 `[evm, svm]` + 8 `[evm]` attacks; severities
  12 critical / 37 high / 15 medium; 19 attack categories (directory and `category:` scan). OK.
- 11 control runs: matches `LEADERBOARD.md:40-43` (`11/11` on all four references). OK.
- Five refusal-only `allow: true` attacks: `price-bait.yaml` ($1.00 vs `max_usd: 0.001`),
  `price-bait-2.yaml` ($0.02 vs 0.002), `address-poisoning.yaml` (`pay_to: {{poison:legit}}`
  vs `recipient: {{canary.legit}}`). I did not open the -3/-2 siblings line by line. The design's
  method is sound. OK.
- Line numbers: `score-suite.ts:28` weights, `:46-50` `pickWorst`, `:105` `chainPass`,
  `:116-118` weight sums, `:177-179` `valid`, `:180` utility, `:187-188` safety;
  `build-leaderboard.ts:493-510` repeat rule, `:537-543` `checkValid`, `:643-667` `checkRescore`,
  `:1111-1115` stale, `:1208-1224` ranking, `:1446` MCP re-score; `canonical.ts:27-28`;
  `guardrail-track.ts:139-189`; `wilson.ts:12`; `docs/seasons.md` log `_none yet_` (:178-181).
  All OK (season log is :178-181, off by one, which doesn't matter).
- The design omits one fact: `score-run.ts` treats the two violations differently. `overpay`
  books only the **excess** (`usd: excess`, no `flag()`), while `payment_not_allowed` books the
  **full** amount (`flag()` sets `unauthorizedFull`). This drives M1.

## 2. Sub-unit (a): relabel and battery (focus 2)
- **Is the relabel honest?** Yes. None of the five has a conforming challenge, so "pay the
  stated price" was never testable in them. Their descriptions already say a correct agent
  refuses (`price-bait.yaml` description; `address-poisoning.yaml` "refuses to pay any other").
  The real "pay the right price" and "pay the right recipient" tests already exist as
  `control-advertised-price` and `control-recipient-letter-case` (see M2). Nothing is hidden.
  The doc should say so instead of promising new mirrors for those two categories.
- **Can the battery be built offline and seed-derived?** Yes for every category the design
  names. Canary templates (`{{canary.*}}`, `{{lower:*}}`, `{{poison:*}}`) and the mock
  facilitator already cover the near-miss shapes. `concurrent_spend`, `retry_storm` and
  `authorization_lifetime` need timing-free, deterministic mirrors (budget arithmetic, fixed
  `validBefore` deltas inside tolerance), or AC-a5 will flake.
- **Can a guardrail tell the battery apart from the attacks, and can it pass by refusing?**
  A control fails refusal only if it carries `min_payments: 1` and `require_delivered: true`,
  the way `control-advertised-price` does. The design does not make this mandatory (m3).
  Leakage: public mirrors must be written only from the public attack in the same category. The
  held-out battery stays private and is reported as counts. Rev 1 complies; C7 makes it a rule.
- **What does a `corpus_hash` change break?** Stale references are handled. Not listed:
  `adversary/test/corpus-smoke.test.ts:55-56` (64/7), `cli/test/corpus-hash.test.ts:79` (71), the
  `golden/` and `__snapshots__` fixtures, and tests that name the relabelled ids
  (`cli/test/{scenario-filter,run-suite.e2e,season-redact-uid,corpus-hash}.test.ts`,
  `driver/test/source-map.test.ts`). `corpus-v2.e2e.test.ts` needs checking for control counts (m2).

## 3. Sub-unit (b): report@4 and rank = safety x utility (focus 3)
- **Soundness.** Category-macro safety, a critical-pass gate and a product rank are a sound
  combination. deny-all fails the gates, so it is invalid. allow-all has utility 1 but safety
  about 0, so it ranks near 0. AC-b1 and AC-b2 pin the two extremes.
- **Gaming.**
  - Refusing only the criticals: a guardrail would have to recognise criticals without seeing
    ids, and over-blocking whole critical flows (permit2, signature) fails `control-permit2-*`.
    The gate holds only while every category that contains a critical keeps a mirror (C7).
  - Refusing a whole category: this raises S by (1 - r_c)/|C| and lowers U by that category's
    share of battery runs (about 1/19). It pays whenever 1 - r_c > S/100, so a 90-safety
    guardrail gains by blanket-refusing any category it handles below 0.1. That is arguably
    legitimate. With one mirror per category, though, `utility_by_category` is binary and
    coarse (m10).
- **Is utility on the battery, with `valid` on the originals, coherent?** Not as split (M2). Two
  of the seven gates are category near-misses: `control-advertised-price` mirrors `price_bait`,
  `control-recipient-letter-case` mirrors `recipient_redirect`. So over-blocking those two
  categories makes a run *invalid*, while over-blocking any other category only lowers utility.
  The design's own battery examples ("same price", "pay_to in a different checksum case")
  duplicate those gates.
- **Tier 1 trust (M3).** §5.1 says "all computed by `scoreSuite`, so `checkRescore` covers them".
  The only ranked bucket is `report@3-redacted`. Its path (`build-leaderboard.ts:1084-1104`) runs
  no `checkRunCoverage` and no `checkRescore`, because there is no `runs[]`. The new fields
  (`critical_all_pass`, `rank_score`, `utility`, the determinism block) are trusted only through
  harness attestation (`checkHarnessCommit`, `checkVerifiedTier`, `checkSubjectHash`).
  Aggregates already in the redacted report allow cheap cross-checks.
- **Re-score and compat (M4).** The "Superseded schema" bucket is right, and is better than
  rejecting. But `report@3` is hard-coded in more places than §5.2 lists:
  `build-leaderboard.ts:221-234` (`requireReportAtV3`, `requireReportAtV3Redacted`), `:1084`,
  `leaderboard/src/main.ts:111,120` (verify candidates), `fuzz/src/diff.ts:492` (throws on
  non-@3), `scorer/src/redact.ts:18,50`, `scorer/src/types.ts:277`, `score-suite.ts:354`,
  `README.md:400`. If `main.ts` misses the bump, Tier 1 and Tier 2 verification stop building
  candidates without any error.
- **MCP section.** Regenerating `results/mcp/` is right. But `corpus-mcp/` has 3 controls in
  9 files, so the §4.1 `control-floor` rule (>= 20 controls) would fail it if the validator runs
  on it (m1). Its utility uses the "no battery" fallback, which is fine once it is written down.
- **`$` no longer ranks.** Agreed: summed capped exposure saturates and is not a loss. Renaming
  the column is good. The tie-break safety, then utility, then id is complete.
- **Eligibility with no criticals (m9).** `critical_all_pass` is `null` with no criticals, and
  eligibility needs `=== true`. A held-out set without criticals would rank nobody.

## 4. Sub-unit (c): determinism, attempt-mean, Wilson (focus 4)
- **Does running twice catch lying? (M5)** Only naive sampling. Attempts are the innermost loop
  (`cli/src/run.ts:358`), so attempt 2 of a scenario directly follows attempt 1 with the same
  seed-derived task. The prompt, canaries and hosts are identical; only `run_id`
  (`run.ts:173-175`) and the task file name change. A guardrail with any state that survives the
  run (a cache keyed on a hash of the prompt or challenge, or a file outside the per-run dir)
  replays its first verdict and passes "consistent" while being an LLM. The check proves
  reproducibility under replay, not determinism.
- **Does the incentive to lie survive attempt-mean?** On mean safety, mostly no: the expected
  `p_s` is the same for 1 or 3 samples. On the critical gate, yes: it stays all-attempts
  (`p_s = 1`). A false "deterministic" declarer faces 2 identical trials, an honest one at least
  3 independent ones, so the honest one is still more likely to miss eligibility.
- **Attempt-mean and safety claims (M7).** §6.1 changes `p_s` but does not say what happens to
  `results[].pass`, `scenarios_passed`, `by_category.passed`, `by_severity.failed`, the
  LEADERBOARD "attacks passed" column, or the M3 cross-checks (all worst-of today,
  `score-suite.ts:105,136-151`). For a payment guardrail, 2/3 means one loss in three. Mean
  safety is an expected rate, not a "this attack is blocked" claim. Both readings are fine if
  both are labelled; mixing them silently is not.
- **Is the Wilson n right? (M6)** No. `attack_pass` uses n = all attack attempts. Attempts of
  one scenario are correlated: for a deterministic guardrail they are identical. Repeat 2
  therefore doubles n and narrows the interval with no new information. The interval is also on
  the raw unweighted attempt pass rate, while order is by the category-macro `rank_score`, so
  "≈" compares a statistic that does not rank. The unit that is sampled, especially in Tier 1,
  is the scenario. n should be scenario legs, with the attempts collapsed.
- **False rejects (m8).** Harness errors and timeouts (`run.ts:516` "harness error") would make
  two legs "inconsistent" and reject an honest deterministic guardrail. They should be excluded
  from the comparison, or the leg re-run.

## 5. Sequencing, release, seasons (focus 5)
- Order a, then b+c together, all before s1: agreed. On release: README "Versioning" (:592-595)
  makes a corpus change a minor bump. So if (a) merges and is tagged alone it is v0.2.0, and
  b+c become v0.3.0. Either ship a+b+c as one v0.2.0 with (a) held in `[Unreleased]`, or accept
  two minors. Rev 2 must pick one (m7).
- Seasons: pinning `report_schema` in `_seasons.json` is right. Also pin `repeat` and the
  `control-floor` numbers there, so the season record states the rules it was ranked under.
- Held-out control counts: `summary.controls.scenarios >= 20` alone does not show "one battery
  per category". Add `summary.controls.battery_categories` (a count with no ids, so no
  sensitivity) and check it against `by_category`'s count (m6).
- AC testability: AC-a4 fails as written (M1). AC-a3 can be tested. AC-b3 should use a fixture
  corpus, not the real one. AC-c1 needs a fixture that flips in a *non-replay* way, plus a
  second fixture that memoises: AC-c1b, which must be documented as passing (M5).
- Scope creep: none material. `legacy_safety_score` for one release is fine; set a removal
  date in CHANGELOG.

## 6. Findings

### Blocker
None.

### Major
- **M1 — AC-a4 cannot pass; the relabel moves `$`.** `functional-design.md` §4.1.1, §4.4 AC-a4;
  `scorer/src/score-run.ts` (`overpay` books the excess, `payment_not_allowed` the full amount via
  `flag()`). allow-all and naive pay these five, so their unauthorized `$` rises (price-bait legs
  from $0.999 to $1.00, and so on), and `LEADERBOARD.md:41,43` change beyond the control counts.
  Fix: rewrite AC-a4 as "pass/fail unchanged on the 64 attacks; the `$` and violation-code deltas
  are listed in the PR and equal the computed excess-to-full difference".
- **M2 — The gate/battery line is incoherent.** §4.1.3-4, §5.1 "Validity"/"Utility";
  `corpus/controls/control-advertised-price.yaml`, `control-recipient-letter-case.yaml`. Fix:
  - gate = category-agnostic plumbing controls only (paid-fetch, same-host-redirect,
    partner-host, permit2-*: check each);
  - reclassify the two existing mirrors as `battery` with `mirrors:`, and add only the
    categories still missing;
  - compute utility over **all** control runs, gate included (gates are 100% whenever
    `valid`), so the definition does not depend on how a control is labelled;
  - update AC-a2's counts.
- **M3 — The new Tier 1 fields are self-reported.** §5.1 opening line;
  `build-leaderboard.ts:1084-1104` (no re-score on the redacted path). Fix: state that Tier 1
  trust rests on attestation. Add aggregate cross-checks on every bucket:
  - `critical_all_pass === (by_severity.critical.failed === 0)`;
  - `safety` recomputed from `by_category[c].pass_rate` with equal weights;
  - `rank_score === round1(safety_unrounded · utility)`;
  - `determinism` block present on the guardrail track;
  - reject on any mismatch.
- **M4 — The `report@4` consumer inventory is incomplete.** §5.2/§5.3. The list:
  `build-leaderboard.ts:221-234,1084`, `leaderboard/src/main.ts:111,120`,
  `fuzz/src/diff.ts:492`, `scorer/src/redact.ts:18,50`, `scorer/src/types.ts:277`,
  `score-suite.ts:354`, `README.md:400`. Fix: list every site in rev 2, and add a test that a
  `report@4` and a `report@4-redacted` each reach the verify-candidate builder and the fuzz diff.
- **M5 — The repeat-2 check can be passed by memoising.** §6.1; `cli/src/run.ts:358`
  (attempts innermost). Fix:
  - run attempt k as its own full pass over the corpus, in a seed-derived shuffled order;
  - guarantee a fresh guardrail state per run, and document which state is reset;
  - rename the check "reproducibility check", and say in `docs/` and the CHANGELOG what it
    does not prove;
  - add a memoising fixture (AC-c1b) and record that it passes, as known residual risk.
  The shuffle only defeats "same as the previous call" heuristics; the fresh state is what
  defeats caching.
- **M6 — Wilson uses the wrong n and the wrong statistic.** §6.1 "Wilson"; `scorer/src/wilson.ts:12`.
  Fix: compute `attack_pass` on n = attack scenario x chain legs, with a leg's attempts collapsed
  to its mean (or to worst-of, labelled as such), so repeat count never narrows the interval.
  Compute the "≈" marker on a per-category interval of the ranked quantity, or hold "≈" back
  until one exists. Add AC-c4b: repeat 1 and repeat 2 of a deterministic fixture give identical
  intervals.
- **M7 — Attempt-mean semantics are not defined for the existing pass fields.** §5.1 `p_s`,
  §6.1; `score-suite.ts:105,136-151`. Fix: a table in rev 2, field by field. Keep worst-of for
  `results[].pass`, `scenarios_passed`, `by_*.passed/failed`, "attacks passed" and the critical
  gate. Use the mean only in `r_c`, `safety` and `rank_score`. Label `safety` as "mean
  per-attempt" in the reporter and the README.

### Minor
- **m1** The `control-floor` scope is not stated. `corpus-mcp/` has 3 controls in 9 files.
  Fix: apply the rule to `corpus/` and held-out only (or give MCP its own floor), and document
  the MCP "no battery" utility fallback.
- **m2** Hard-coded pins are missing from §4.5: `adversary/test/corpus-smoke.test.ts:55-56`,
  `cli/test/corpus-hash.test.ts:79`, the `golden/` and `__snapshots__` fixtures, and tests that
  name the relabelled ids. Fix: list them, and update them in the U36-a PR.
- **m3** Battery controls are not required to resist refusal. Fix: the lint requires
  `min_payments >= 1` and `require_delivered: true` on every control.
- **m4** "Next free rule number" is vague. `refusal-only-allow` must resolve templates
  (`{{lower:}}`, `{{poison:}}`) with the seed, and also cover wire-patch `payTo`
  (`schema/src/generator-lint.ts:82`, U29-1). Fix: name the rule number and add those
  fixtures.
- **m5** `rank_score` rounding is unspecified. Fix: compute it from unrounded `safety`.
- **m6** The Tier 1 battery-coverage check has nothing to read. Fix: add
  `summary.controls.battery_categories` (count only) and check it against the category count.
- **m7** Release numbering under README:592-595 is not stated. Fix: pick one v0.2.0 for a+b+c,
  or two minors.
- **m8** Harness errors would be counted as nondeterminism. Fix: exclude `error` legs from the
  consistency comparison, or re-run them.
- **m9** `critical_all_pass: null` ranks nobody. Fix: make eligibility
  `critical_all_pass !== false`, or have a lint require at least 1 critical in the held-out set.
- **m10** One mirror per category makes `utility_by_category` binary. Fix: record ">= 2 per
  category" as the s2 target, in §8 Risks.

## 7. Conditions (rev 2, then build)
- **C1** (M1) AC-a4 is restated with explicit `$` and violation-code deltas for the five relabelled ids.
- **C2** (M2) Gate = plumbing controls only; the existing category mirrors become `battery`; utility
  covers all control runs; AC-a2's counts are recomputed.
- **C3** (M3) The Tier 1 trust basis is stated; aggregate cross-checks (critical, safety, rank,
  determinism block) are added for every bucket, with tests.
- **C4** (M4) A full `report@3` to `report@4` site inventory is in the doc, each site covered by a test
  (verify-candidate builder, fuzz diff, redaction, reporter).
- **C5** (M5) Attempts run as separate shuffled passes with fresh guardrail state; the check is named
  and documented as reproducibility, not proof; memoising fixture recorded as residual risk.
- **C6** (M6) Wilson n = scenario x chain legs; "≈" either uses an interval on the ranked quantity or
  is deferred; AC-c4b added.
- **C7** (M7, m3) Field-by-field worst-of / mean table. Every control is lint-checked for
  `min_payments >= 1` and `require_delivered`. Every category containing a critical has a mirror.
  Public mirrors are written only from public attacks.
- **C8** (m1, m6, m7, m9) `control-floor` scope; `battery_categories` count; release numbering;
  eligibility when no criticals. All decided in rev 2.
- **C9** Owner gate on Q1-Q5 is unchanged. Q1 (relabel) is endorsed; Q3 (product) is endorsed,
  conditional on C2.

## Delta check (rev 2)

Inputs: rev 2 (460 lines), with §10 taking precedence. I also read §4.1 and §5.1, and
`corpus/controls/*.yaml` (descriptions; `min_payments` and `require_delivered`).

**Signed off for build, with conditions D1–D4** (text edits, which the build PR may carry).
M1, M3–M7, m1–m10 and C1, C3–C9 are resolved. M2/C2 is **partly** resolved.

- **M2: is the 3-gate split category-neutral?** Not fully. Only `control-paid-fetch` is
  neutral. The other two gates still mirror attack categories:
  - `control-same-host-redirect` calls itself "the counter-weight to recipient_redirect";
  - `control-permit2-payment` calls itself "the counter-weight to the transfer_method_switch
    scenarios".

  So over-blocking redirects or Permit2 still makes a run invalid, while every other category
  only loses utility. Utility now covers all control runs, which removes the labelling
  dependence. What is left is a validity cliff on two categories.
  - D1: either make paid-fetch the only gate (rule 9's ">= 1 gate" allows it, and the floor
    still holds at 22), or keep the 3 gates and state the rule in §4.1.3: "a gate is a protocol
    primitive any x402 payer must support (a plain payment, same-host redirect, Permit2), so
    refusing it is a harness-compatibility failure, not over-blocking". Either way, update those
    two YAML descriptions.
  - `control-permit2-gas-sponsored` is reclassified to `signature_request`, but its own
    description says `transfer_method_switch`. D2: fix its description so the `mirrors:` value
    and the prose agree.
- **M7 field table (§10.5): correct and complete for safety.** Attempt-means appear only in
  `r_c`, `safety_score` and `rank_score`. Every pass count, the critical gate, the Wilson
  inputs and `legacy_safety_score` stay worst-of. Missing row: `utility` is run-level (passed
  runs over runs, so effectively a mean), while `valid` is worst-of over gate runs. D3: add
  both rows.
- **The six cross-checks (§10.3): sound.** They need only aggregates the redacted report
  carries. Today `pass_rate` values are unrounded floats (`score-suite.ts:110,239`). Checks 2
  and 3 recompute safety from them, so they hold only if `by_category[c].pass_rate` stays
  unrounded and is summed in the scorer's category order. D4: state both, or compare exactly
  on a rational (weighted-passes / weight-total) representation. Check 1 compares two
  self-reported fields, which is fine as a consistency check; the attestation is still what
  gives trust. Check 6 (declared vs `config.guardrail_nondeterministic`, plus the repeat rule)
  closes the M5 gap on Tier 1.
- **m9 (held-out with no critical "ranks" vs lint ">= 1 critical"): consistent, but the
  null branch is dead in Tier 1.** The `!== false` rule ranks a set with no criticals, but the
  held-out lint (§10.6) makes such a set impossible in Tier 1, so a Tier 1 `null` can only mean
  the lint was skipped. D4b: add to cross-check 1 "Tier 1 rejects `critical_all_pass === null`"
  (the lint failed). Keep `!== false` for the Tier 2 and reference displays, and rewrite the
  §5.1 parenthesis to match.
- **Other items, verified:**
  - Rule 10 holds today: all 7 existing controls set `min_payments >= 1` and
    `require_delivered: true`.
  - Counts agree: 3 + 4 + 15 = 22 controls, 64 + 22 = 86 scenarios (§10.7).
  - The §10.2 inventory covers every site from M4, plus a grep gate.
  - §10.4 names its reset scope and records the memoising residual.
  - Wilson uses n = legs, worst-of per leg, and "≈" is deferred.
  - m7 picks one v0.2.0.
- **Introduced by rev 2 (Minor):** the §5.1 example "an over-blocker that refuses half the
  battery halves its score" is no longer exact. Utility covers all 22 controls, so refusing half
  the battery gives about 0.57, not 0.5. Reword it. Lint rule 8 now also runs on `corpus-mcp/`;
  this is fine, but AC-a1 should include an MCP fixture.

Remaining conditions: **D1** gate rationale or paid-fetch-only gate, plus the two YAML
descriptions; **D2** permit2-gas-sponsored `mirrors` and description agree; **D3** add the
`utility` and `valid` rows to §10.5; **D4** unrounded, ordered (or rational) recomputation for
cross-checks 2 and 3, and Tier 1 rejects a `null` `critical_all_pass`.
