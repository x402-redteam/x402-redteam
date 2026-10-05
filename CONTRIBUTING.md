# Contributing

## Submit a guardrail result to the leaderboard (provenance tiers, ADR-011)

The [leaderboard](LEADERBOARD.md) shows three tiers. **Only Tier 1 is ranked.** See
[`docs/seasons.md`](docs/seasons.md) for the full season lifecycle.

| Tier | Table | How | Who can produce one |
|---|---|---|---|
| 1 | **Ranked (held-out)** | a maintainer runs `.github/workflows/ranked-run.yml` against the current season's held-out corpus | maintainers only (the `ranked` environment's required reviewers) |
| 2 | **Verified (public corpus)** | your own public repo calls the reusable `.github/workflows/rank.yml@<release tag>` against the public corpus | anyone, via a PR that adds the workflow call |
| 3 | Self-reported | a committed `results/<id>.json` with no attestation | **rejected by default** — shown in the Rejected section, not displayed (user decision; may change at G8) |

### Getting a Tier 2 "Verified (public corpus)" result

1. In your own public repo, add a workflow that calls this one:

   ```yaml
   jobs:
     rank:
       uses: ORG_PLACEHOLDER/x402-redteam/.github/workflows/rank.yml@v1.0.0 # pin a real release tag
       with:
         harness-ref: v1.0.0 # the same release tag, vMAJOR.MINOR.PATCH (rank.yml rejects anything else)
         guardrail-cmd: "node my-guardrail.js" # your GDP guardrail (ADR-010)
         guardrail-id: your-guardrail-id
   ```

   (`ORG_PLACEHOLDER` — the harness's own org/repo isn't decided yet; see
   [`docs/seasons.md`](docs/seasons.md#the-org-placeholder) for the one place this gets
   updated once it is.)

2. That workflow runs the canonical guardrail-track config against the public corpus and
   attests `report.json` under GitHub's own build provenance. Download the attestation
   bundle from the run and the `report.json` artifact.
3. Commit all of this into this repo:

   ```bash
   cp report.json results/<your-guardrail-id>.json
   cp attestation.jsonl results/<your-guardrail-id>.attestation.jsonl
   ```

   Add your GitHub login/org to `results/_meta.json` as this entry's `owner` — the
   `gh attestation verify --owner` check (security review HIGH-6) needs it, since the
   signer-workflow path alone only names this harness's own `rank.yml`, not *your*
   repo:

   ```json
   { "<your-guardrail-id>": { "owner": "your-github-login" } }
   ```

4. Open a PR (`results/_verified.json`, `_harness.json` and `_seasons.json` are
   [`CODEOWNERS`](.github/CODEOWNERS)-protected, so this always needs a maintainer
   review). A maintainer runs `pnpm leaderboard -- --verify-attestations` (the only
   step that calls `gh attestation verify`, and only this step — `pnpm leaderboard`'s own
   default path never makes a network call; `verify-results.yml` also runs this
   automatically as a CI check on any PR touching `results/**`), which writes
   `results/_verified.json` and regenerates `LEADERBOARD.md`. Your result then appears
   under "Verified (public corpus)" — never merged into the ranked table above it —
   once it also passes every other acceptance check:
   - `report.json`'s `schema` is `x402-redteam/report@3`.
   - Its `corpus_hash` matches the current corpus (a mismatch lands it under "Stale
     corpus" instead, not rejected — rerun against the current corpus and update your
     PR).
   - `config` is the canonical configuration (default seed, both chains, no `--scenario`
     filter, controls included, `host_mode: localhost`, `driver: driver@1`).
   - `config.guardrail_repo_ref` is set (security review HIGH-12) — `rank.yml` sets this
     for you to `${{ github.repository }}@${{ github.sha }}`.
   - `summary.valid` is `true` (every control passed — ADR-009).
   - **Re-scoring `runs[]`** reproduces the stored summary and per-scenario results
     exactly.
   - The filename matches `guardrail_id`, and no other committed file claims the same
     id.
   - `harness_commit` is on the release allowlist (`results/_harness.json`) — **and
     that allowlist must itself be concrete**: an absent file, or one that still says
     `{"allow": ["*"]}`, rejects every Tier 1/2 submission outright (security review
     condition #14 — there is nothing permissive about "not configured yet").
   - `results/_verified.json`'s `subject_sha256` for your entry matches the content
     hash of what's actually committed today (security review HIGH-5) — editing
     `results/<id>.json` after it was attested, without re-attesting, is caught here.

   Any of these failing (including a missing/invalid attestation) lands your submission
   in `LEADERBOARD.md`'s "Rejected" section with the specific reason, not silently
   dropped.

### Getting a Tier 1 "Ranked (held-out)" result

Tier 1 is maintainer-initiated only — open an issue asking for a ranked run of your
open-source guardrail, pinned to a commit SHA. A maintainer runs
`.github/workflows/ranked-run.yml` (requires the `ranked` environment's approval) against
the current season's held-out corpus, inside a `--network none` container, and publishes
only `report.redacted.json` (no `runs[]`, no violation messages) plus its attestation.

**What this does and doesn't prove.** Tier 2's checks (above) catch a hand-edited summary
or a non-canonical run, and its attestation proves *which workflow* produced the file —
but a submitter's own job still controls the guardrail's code in the same job that
attests the result, so same-job tampering is a known residual (disclosed on the
leaderboard page). Tier 1 closes that gap: the job is maintainer-controlled, the corpus
is unknown to the submitter until the season ends, and nothing about the run is visible
to the submitter beforehand. `reference`-kind entries (`naive`, `guarded`, `allow-all`,
`reference-policy`, ...) are harness-authored oracles used to sanity-check the harness
itself, never evidence that any real guardrail is safe (ADR-008 amendment), and never
carry an attestation — they don't appear in either tiered table.

Only commit `results/<id>.json` (and, once attested, `results/<id>.attestation.jsonl`) —
not your agent's own source, unless you're also contributing it as a reference/example
agent (see below). Never commit anything under `results/internal/` — that directory
holds harness-internal baselines the leaderboard deliberately never reads.

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
pnpm leaderboard                          # offline; reads results/_verified.json as-is
pnpm leaderboard -- --verify-attestations # maintainer-only: calls `gh attestation verify`
```

Node ≥ 20, pnpm 10 (pinned via `packageManager` + corepack). Dependencies are pinned to exact
versions throughout the workspace; please keep new ones exact too.
