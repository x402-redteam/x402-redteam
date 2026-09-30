# U13 — Leaderboard hygiene (canonical config, re-scoring, honest docs) · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 5 · Contract: application-design §7 "(v2, Bolt 5)", ADR-011 (partial), ADR-015, ADR-008 amendment
Starts after U9 Part B, U10 and U11 are merged (Phase C). The corpus and report@2 must be final. Runs in parallel with U12.

## 1. Goal
The leaderboard accepts only reports that are:
- produced under the canonical configuration;
- valid (controls passed);
- self-consistent (re-scoring `runs[]` against the current corpus reproduces the stored scores).

Ranking uses the safety score. The docs stop overstating integrity. This does **not** solve provenance; ADR-011's attestation and held-out corpus are Bolt 6, and CONTRIBUTING must say so.

## 2. Files (U13 owns these in Bolt 5)
```
packages/leaderboard/src/build-leaderboard.ts   acceptance checks, ranking v2, rejected section, columns v2
packages/leaderboard/src/main.ts                loads corpus, passes scenarios for re-scoring
packages/leaderboard/test/*
examples/agents/src/sdk-default.ts              NEW baseline: shared crawler + bare wrapFetchWithPayment, SDK defaults, no policy
results/naive-baseline.json, results/guarded-reference.json   regenerated (report@2)
results/internal/sdk-default-baseline.json   NEW, internal only (user decision G5): the leaderboard never reads results/internal/
results/_meta.json                              NEW  { "<id>": { "kind": "reference" } } — which entries are harness-authored
LEADERBOARD.md                                  regenerated
CONTRIBUTING.md                                 submission rules v2 + honest integrity statement
README.md                                       quickstart sample output + "Leaderboard" section only (U12 owns the Integration section)
```

## 3. Acceptance checks (each failure → the "Rejected" section with its reason; never ranked)
1. `schema === "x402-redteam/report@2"`.
2. `corpus_hash` equals the current corpus (as today → "Stale", which is kept distinct from Rejected).
3. `config.seed === "x402-redteam-v1"`, `config.chains` = `["evm","svm"]`, `config.scenario_filter === null`, `config.controls_included === true`, `config.repeat ≥ 1`.
4. `summary.valid === true`.
5. **Re-score:** strip the stored scores, and run `scoreSuite({scenarios: current corpus, runs: report.runs (timing := 0), ctx:{seed}, meta})`. `summary`, `by_category`, `by_severity` and `scenarios` must deep-equal the stored ones. This catches hand-edited summaries, not edited `runs[]`, which is the documented residual risk.
6. The filename stem equals `guardrail_id`, and ids are unique (Review 1, m4).

## 4. Ranking and columns
- Sort by `safety_score` desc, then capped `unauthorized_usd` asc, then id.
- Columns: `rank | entry | kind (reference/submitted) | safety score | attacks passed | controls | unauthorized $ (capped) | worst category | repeat | corpus | harness`.
- `kind` comes from `results/_meta.json`. The header text states that reference entries are harness-authored oracles, not evidence of real-world safety (ADR-008 amendment).

## 5. Docs
- **CONTRIBUTING:**
  - replace "a result is never taken on trust" with an accurate statement: the checks above run in CI; results are self-submitted; provenance attestation and a held-out ranked corpus are planned (ADR-011);
  - maintainers may re-run any submission, and results that can't be reproduced are removed;
  - give the canonical command line;
  - an LLM agent should use `--repeat 5`.
- **README:**
  - regenerate the quickstart sample from a real naive run (capped $, notional $, safety score, controls line);
  - document exit code 2 = harness error **or** invalid run (ADR-009).

## 6. Acceptance tests
- Unit, one fixture per rejection reason: an evm-only report; a non-default seed; `--skip-controls` (valid null); an invalid suite (the `true` agent); a tampered `summary.unauthorized_usd`; a filename/id mismatch. Each lands in Rejected with the right reason.
- Stale detection still works.
- `pnpm leaderboard` over the committed results gives **2 ranked entries**: guarded-reference (safety 100), then naive-baseline (lowest). Both are marked `reference`.
- `results/internal/sdk-default-baseline.json` exists and is valid, and **does not appear** in LEADERBOARD.md. A test asserts that `results/internal/` is ignored. (User decision at G5: the SDK-default baseline stays internal until launch.)
- The CI diff-check is green.
- The markdown output is byte-deterministic.

## 7. Do not
- Edit `packages/scorer/**`. If re-scoring needs an export (e.g. a `rescore()` helper), request it via the orchestrator; U9 owns the scorer.
- Edit the corpus, the adversary, capture or the CLI.
- Commit LLM or Python results (U12 results are experimental).
- Claim provenance or anti-gaming properties the code doesn't have.
- Commit, except the single worktree commit.


## Addendum (orchestrator, from ADR-010 amendment)
LEADERBOARD.md must carry a prominent "Unranked / experimental: scores are not yet comparable across guardrails (see ADR-010)" banner at the top, and the column header "rank" becomes "#". Tested by snapshot.
