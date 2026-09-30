# Contributing

## Submit a guardrail result to the leaderboard

**LEADERBOARD.md is currently unranked / experimental** (ADR-010): the guardrail-track standard
driver that would let scores be compared fairly across different guardrails hasn't shipped yet, so
pass/fail today still depends partly on crawl and retry behaviour, not only on the guardrail under
test. Submissions are still welcome and still checked — see below — but treat the numbers as
"passed the harness's own acceptance checks", not as a certified ranking.

The [leaderboard](LEADERBOARD.md) is generated from committed `results/*.json` report files. To
add (or update) yours:

1. Run the harness against your agent, against the full bundled corpus with the **canonical
   configuration** (default seed, both chains, controls included, no `--scenario` filter), giving
   it a stable `--guardrail-id` (this becomes both the committed filename and the name shown on
   the leaderboard). An LLM agent should also pass `--repeat 5`, since a single attempt doesn't
   say much about a non-deterministic agent:

   ```bash
   pnpm x402-redteam run --agent "<your agent command>" \
     --agent-id <your-agent-name> \
     --guardrail-id <your-guardrail-id> \
     --out /tmp/x402-out
   ```

2. Commit the result under that id:

   ```bash
   cp /tmp/x402-out/report.json results/<your-guardrail-id>.json
   ```

3. Regenerate the leaderboard and commit both files:

   ```bash
   pnpm leaderboard
   git add results/<your-guardrail-id>.json LEADERBOARD.md
   git commit -m "leaderboard: add <your-guardrail-id> result"
   ```

4. Open a PR. CI re-runs `pnpm leaderboard`, which checks your submission against every
   acceptance rule before it's ranked:
   - `report.json`'s `schema` is `x402-redteam/report@2`.
   - Its `corpus_hash` matches the current corpus. A **mismatch** (the corpus changed since you
     ran) doesn't reject the result — it's listed separately under "Stale corpus" in
     `LEADERBOARD.md`, not ranked. Rerun step 1 against the current corpus and update your PR.
   - `config` is the canonical configuration above (default seed, both chains, no `--scenario`
     filter, controls included).
   - `summary.valid` is `true` (every control passed — see ADR-009).
   - **Re-scoring `runs[]`** — stripping the stored scores and re-running the scorer against the
     current corpus — reproduces the stored summary and per-scenario results exactly. This is
     what actually catches a hand-edited summary.
   - The filename matches `guardrail_id`, and no other committed file claims the same id.

   Any of these failing lands your submission in `LEADERBOARD.md`'s "Rejected" section with the
   specific reason, not silently dropped — fix it and update your PR.

**What this does and doesn't prove.** The checks above run in CI and are not a rubber stamp: a
result that only hand-edits its own summary, or that was run with a non-canonical configuration,
is caught and rejected. But results are still **self-submitted** — nothing here proves *who* ran
the harness, or that `runs[]` itself wasn't edited before the scores were computed from it.
Provenance (a public-CI attestation, or a maintainer re-run) and a held-out, seasonal ranked
corpus are planned (ADR-011) but not built yet; maintainers may re-run any submission by hand, and
a result that can't be reproduced is removed. `reference`-kind entries (`naive`, `guarded`, and
similar) are harness-authored oracles used to sanity-check the harness itself, not evidence that
any real guardrail is safe (ADR-008 amendment) — they're never the only "passing" evidence for a
claim about the corpus.

Only commit `results/<id>.json` — not your agent's own source, unless you're also contributing it
as a reference/example agent (see below). Never commit anything under `results/internal/` — that
directory holds harness-internal baselines the leaderboard deliberately never reads.

## Add a scenario

Adding a new attack category or variant is a YAML-only PR — no code changes, per NFR6. See
[`corpus/README.md`](corpus/README.md) for the full field-by-field schema reference, the
templating and canary rules, and the naming conventions the loader enforces. In short:

1. Create `corpus/<id>.yaml` (the loader walks subdirectories too). `id` must equal the filename.
2. Write the task prompt like a real job: name the legitimate host(s) via `{{host:NAME}}`, state
   the budget in words, and never hint at the attack itself.
3. Run:

   ```bash
   pnpm --filter @x402-redteam/schema test
   pnpm --filter @x402-redteam/adversary test
   ```

   Both must pass unmodified — that's what makes a new scenario "just a YAML file" rather than a
   code change.
4. Add a row to the scenario table in `corpus/README.md`.

Changing an *existing* scenario's `id`, `chains`, `expected` or challenge shape changes the
corpus hash, which will make every previously-committed `results/*.json` show up as stale on the
leaderboard until their owners rerun — do this deliberately, and call it out in your PR.

## Development

```bash
pnpm install
pnpm lint       # biome check .
pnpm typecheck  # tsc --noEmit, per package
pnpm test       # vitest run, all packages
pnpm leaderboard
```

Node ≥ 20, pnpm 10 (pinned via `packageManager` + corepack). Dependencies are pinned to exact
versions throughout the workspace; please keep new ones exact too.
