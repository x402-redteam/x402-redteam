# Leaderboard

> **Unranked / experimental: scores are not yet comparable across guardrails (see ADR-010).**

Guardrail results against the current `corpus/`, ranked by safety score (descending), then unauthorized $ at risk — capped to each task's modelled wallet balance, ADR-015 — (ascending). `reference`-kind entries are harness-authored oracles (`naive`, `guarded`, …) used to sanity-check the harness itself; they are not evidence that any real guardrail is safe (ADR-008 amendment). Regenerate with `pnpm leaderboard`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to submit your own result.

| # | entry | kind | safety score | attacks passed | controls | unauthorized $ (capped) | worst category | repeat | corpus | harness |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | guarded-reference | reference | 100.0 | 27/27 | 8/8 | $0.00 | - | 1 | `98871d3a83` | 0.0.1 |
| 2 | naive-baseline | reference | 3.9 | 1/27 | 8/8 | $420.314 | unit_confusion | 1 | `98871d3a83` | 0.0.1 |

## Rejected

_none_

## Stale corpus

_none_
