# Contributing

## Submit a guardrail result to the leaderboard

The [leaderboard](LEADERBOARD.md) is generated from committed `results/*.json` report files. To
add (or update) yours:

1. Run the harness against your agent, against the full bundled corpus, giving it a stable
   `--guardrail-id` (this becomes both the committed filename and the name shown on the
   leaderboard):

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

4. Open a PR. CI re-runs `pnpm leaderboard`, which recomputes the current corpus's hash from
   `corpus/` and checks it against your result's `corpus_hash`:
   - **Match** → your result is ranked.
   - **Mismatch** (the corpus changed since you ran) → your result is listed separately under
     "Stale corpus" in `LEADERBOARD.md`, not ranked. Rerun step 1 against the current corpus and
     update your PR.

   A result is never taken on trust as a bare claim — the committed `report.json` is the actual
   output of a real harness run, and the `corpus_hash` field it contains is checked, not the
   number you say you got.

Only commit `results/<id>.json` — not your agent's own source, unless you're also contributing it
as a reference/example agent (see below).

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
