# Seasons (ADR-011)

A **season** is how the leaderboard's ranked table (Tier 1, below) stays honest against
a public seed a submitter could otherwise precompute canaries and run ids from. Each
season has:

- an **id** (e.g. `s1`), a held-out corpus, and a start/end date;
- a **256-bit secret seed**, generated and held offline by the project maintainer (user
  decision, Phase C) — never committed, never logged, never written to a file other than
  the maintainer's own offline backup and the `ranked` environment's `SEASON_SEED`
  secret;
- a public **seed commitment**, `sha256(seed)` hex, published at season start in
  `report.config.seed_commitment` on every ranked run and in this file's own season log
  below.

**Default length: one quarter.** At season end, the seed and the held-out corpus are
**published** and merged into the public corpus (`corpus/`) — anyone can then re-run,
verify `corpus_hash` against the revealed corpus and the commitment against the revealed
seed, and audit the season's ranking after the fact.

## Provenance tiers (ADR-011)

Only **Tier 1** is ranked.

| Tier | Name | Corpus | Report published | Attestation signer |
|---|---|---|---|---|
| 1 | Ranked (held-out) | the season's held-out corpus | `report.redacted.json` (no `runs[]`, no violation messages) | `.github/workflows/ranked-run.yml` |
| 2 | Verified (public corpus) | the public `corpus/` | full `report.json` | `.github/workflows/rank.yml` |
| 3 | Self-reported | either | whatever's committed | none — rejected by default (user decision; may change at G8) |

`pnpm leaderboard` itself never calls `gh attestation verify` (CLAUDE.md: no network
calls from `pnpm leaderboard` or any unit test) — it only reads `results/_verified.json`,
written ahead of time by `pnpm leaderboard -- --verify-attestations` (a separate,
explicit, networked step a maintainer runs by hand, or the `verify-results.yml` CI job,
which runs that same step whenever a PR touches `results/**` - security review HIGH-5).

### `results/_verified.json`, `_harness.json` and `_seasons.json`

Three committed sidecar files gate Tier 1/2 acceptance; all three are
[`CODEOWNERS`](../.github/CODEOWNERS)-protected:

- **`results/_harness.json`**: `{"allow": ["<40-hex-char harness commit>", ...]}`.
  Security review condition #14: **absent or `{"allow": ["*"]}` rejects every Tier 1/2
  entry outright** - the permissive wildcard is only ever "nothing is ranked yet," never
  "anything goes." Filled in with the release commit at G7.
- **`results/_seasons.json`**: `{"<season id>": {"seed_commitment", "corpus_hash",
  "starts", "ends"}}` - the *public* commitment published at season start (never the
  real seed). A Tier 1 report's own `config.seed_commitment`/`corpus_hash` must match
  this record exactly (security review MEDIUM-11); the report alone claiming a value
  proves nothing.
- **`results/_verified.json`**: `{"<id>": {"tier", "signer", "subject_sha256",
  "run_url"?}}`, written only by `--verify-attestations`. `subject_sha256` is a
  canonical-JSON content hash of the committed `results/<id>.json`/`.redacted.json`
  (security review HIGH-5) - `pnpm leaderboard` recomputes it from whatever's actually
  committed today and rejects a mismatch, so an attestation can't be "reused" for a
  file that was edited after it was checked.

## Running a season (maintainer)

1. **Before the season opens:**
   - Generate a seed with **at least 256 bits of entropy** (security review #13:
     `loadSeason` rejects anything shorter - a 64-hex-char or ~43-char base64 string)
     and an `age` keypair offline (never on a shared machine). Store both in the
     maintainer's own offline backup, and add them as the `ranked` environment's
     `SEASON_SEED`/`AGE_KEY` secrets.
   - `corpus/season.json` in the held-out corpus bundle: `{"id": "s1", "starts":
     "2026-01-01", "ends": "2026-03-31"}`.
   - Season 1's held-out scenarios are authored **outside this repo**
     (`$X402_HELDOUT_DIR`, never committed) by an author who did not write any ranked
     guardrail or `reference-policy` (ADR-011 "Ranked-corpus admission"), with a human
     spot-check before the season opens.
   - Encrypt the held-out corpus with `age` (recipient: the season's public key) and
     commit the encrypted bundle to the **private** held-out corpus repo.
   - Publish `seed_commitment = sha256(seed)` (hex) and `corpus_hash` (the held-out
     corpus's own hash) as a new entry in `results/_seasons.json` (security review
     MEDIUM-11), in the season log below, and in the private repo's own README.
2. **During the season:** run `.github/workflows/ranked-run.yml` (`workflow_dispatch`,
   gated by the `ranked` environment's required reviewers, **restricted to the `main`
   branch** - security review HIGH-8, set in the repo's own Settings → Environments)
   once per guardrail being ranked. See `.github/ranked/Dockerfile` / `entrypoint.sh`
   for exactly how the corpus is decrypted and run; `--guardrail-repo-ref` records the
   guardrail's own pinned `org/repo@sha` into the report (security review HIGH-12).
   Afterwards, download the run's attestation bundle and commit it alongside the
   report as `results/<id>.attestation.jsonl`, then run `pnpm leaderboard --
   --verify-attestations` to populate `results/_verified.json`.
3. **At season end:**
   - Publish the real seed and the held-out corpus (merge it into `corpus/`).
   - Anyone can now run `pnpm x402-redteam validate` plus `pnpm x402-redteam run
     --season-seed-env SEASON_SEED --corpus corpus` with the revealed seed and corpus to
     reproduce `corpus_hash`/`seed_commitment` and audit the season's ranking.
   - `results/_harness.json`'s release allowlist is updated to include the harness
     commit the season actually ran at (ADR-011 "Harness identity") - until it is, no
     Tier 1/2 entry can be accepted at all (security review condition #14).

## The org placeholder

The GitHub org/repo layout (a public harness repo, a private held-out corpus repo, and
the `ranked` environment with maintainer-only reviewers) is a Phase C user decision that
hasn't happened yet — **nothing has been created or pushed**. Every place this repo's
own workflows need to name that layout uses one of two parameterized forms instead of a
hardcoded org name, so there is exactly one place to update once the org exists:

- `.github/workflows/rank.yml`'s `harness-repo` input, default
  `"ORG_PLACEHOLDER/x402-redteam"` — update the default (or override it at each call
  site) once the public repo exists.
- `.github/workflows/ranked-run.yml`'s held-out corpus checkout uses the repository
  variable `vars.HELDOUT_REPO` (format `org/repo`) — set it once in the repo's own
  Settings → Secrets and variables → Actions, after the private corpus repo exists.

## Season log

| Season | Starts | Ends | `seed_commitment` | Revealed seed | Held-out corpus merged |
|---|---|---|---|---|---|
| _none yet_ | | | | | |
