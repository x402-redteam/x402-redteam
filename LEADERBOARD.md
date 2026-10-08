# Leaderboard

> **Provenance tiers (ADR-011): only Tier 1 "Ranked (held-out)" below is a ranked result. Tier 2 "Verified (public corpus)" runs the same canonical guardrail-track config on the public corpus under an attested CI workflow, but is never merged into the ranked table. Tier 3 (self-reported, no attestation) is not accepted by default — see the Rejected section and CONTRIBUTING.md.**

Both tables run every guardrail behind the same frozen, maximally attempting standard driver (`driver@1`, ADR-010 §1), so only the guardrail varies — ranked by safety score (descending), then unauthorized $ at risk, capped to each task's modelled wallet balance (ADR-015), (ascending). Harness-authored reference oracles never appear in either table - see the dedicated Reference section below. The **agent track** runs real agents end to end and is never ranked against either guardrail-track table (ADR-010 §4): one row per agent per attack scenario, never pooled across scenarios, because a guardrail that's fine on average and unsafe on the one scenario that matters is exactly what pooling would hide.

Regenerate with `pnpm leaderboard`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to submit your own result.

## Ranked (held-out season)

One sub-table per season - a guardrail's rank is only meaningful within its own season's held-out corpus, never across seasons.

| # | guardrail | hooks | safety | attacks passed | controls | crawl | repeat | prose | challenge | unauthorized $ | guardrail errors | harness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| _no Tier 1 ranked result yet — a season hasn't run, see docs/seasons.md_ | | | | | | | | | | | | |

## Verified (public corpus)

| # | guardrail | hooks | safety | attacks passed | controls | crawl | repeat | prose | challenge | unauthorized $ | guardrail errors | harness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| _no Tier 2 verified result yet — see CONTRIBUTING.md_ | | | | | | | | | | | | |

## Agent track — observations (unranked)

`pass rate (95% CI)` is **this scenario's own** Wilson 95% interval over its own `attempts` (pooled across the chains it runs on) - never one aggregate over every attack run an agent made across the whole corpus.

| agent | scenario | reach class | attempts | pass rate (95% CI) | reached (passed/attempted) | utility |
|---|---|---|---|---|---|---|
| _no agent-track observations for the current corpus yet_ | | | | | | |

## Reference (harness oracles — exempt from tier gating, never ranked)

Harness-authored fixtures (`naive`, `guarded`, `allow-all`, `deny-all`, `reference-policy`, `sdk-defaults`, ...) used to sanity-check the harness itself (ADR-008 amendment) - never evidence that any real guardrail is safe, and never requiring (or eligible for) a Tier 1/2 attestation. Sorted by id, not ranked - the `#` column here is a display ordinal only.

| # | guardrail | hooks | safety | attacks passed | controls | crawl | repeat | prose | challenge | unauthorized $ | guardrail errors | harness |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | allow-all (reference) | payment, transfer, sign | 0.0 | 0/48 | 8/8 | 0/20 | 0/18 | 0/12 | 0/43 | $1,127.95 | 0 | `2eb477e592` |
| 2 | guarded-reference (reference) | — | 100.0 | 48/48 | 8/8 | 20/20 | 18/18 | 12/12 | 43/43 | $0.00 | 0 | `2eb477e592` |
| 3 | naive-baseline (reference) | — | 6.8 | 3/48 | 8/8 | 0/20 | 0/18 | 0/12 | 6/43 | $622.473 | 0 | `2eb477e592` |
| 4 | reference-policy (reference) | payment, transfer | 100.0 | 48/48 | 8/8 | 20/20 | 18/18 | 12/12 | 43/43 | $0.00 | 0 | `2eb477e592` |

## Rejected

_none_

## Stale corpus

_none_
