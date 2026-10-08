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

- **`results/_harness.json`**: `{"allow": [{"commit": "<40-hex-char harness commit>",
  "version": "vX.Y.Z", "image": "sha256:<64 hex>"}, ...]}` - one entry per release, naming
  its commit, tag and ranked image digest (see "Which image ran this result" below). A
  plain commit string is still accepted by `pnpm leaderboard`, but `rank.yml` and
  `ranked-run.yml` only run a release listed in the object form. List each commit once:
  when a release gains its object entry, it replaces any plain string entry for that
  commit rather than sitting beside it. An object entry with a malformed commit (not 40
  hex), version (not `vX.Y.Z`) or image (not `sha256:` + 64 hex) makes `pnpm leaderboard`
  fail. The wildcard rule: **absent or `{"allow": ["*"]}` rejects every Tier 1/2
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
     Tier 1/2 entry can be accepted at all.

## Which image ran this result

Ranked (Tier 1) and verified (Tier 2) runs execute in the ranked container image
(`.github/ranked/Dockerfile`), which is built once per release and never on the ranked
runner itself (ADR-023):

1. **Build and publish.** `release.yml` calls `.github/workflows/release-image.yml`, which
   builds the image for `linux/amd64` with the release commit baked in as `HARNESS_COMMIT`
   (reported as `config.harness_commit`), attaches a BuildKit SBOM and `mode=max`
   provenance, and pushes `ghcr.io/<org>/x402-redteam-ranked:vX.Y.Z` (plus `vX.Y` and
   `vX`; never `latest`). The image is intended to be public (owner decision pending);
   it contains no secrets. `rank.yml` runs in submitters' repos without registry
   credentials, so it needs both the image and the harness repo to be public.
2. **Attest.** The same job attests the pushed digest with `actions/attest`
   (`push-to-registry: true`), signed by `release-image.yml`'s workflow identity. The
   digest and a ready-made `_harness.json` entry are written to the job summary.
3. **Record.** The post-release PR adds `{"commit", "version", "image"}` for the release
   to `results/_harness.json` (CODEOWNERS-protected), replacing any plain string entry
   for the same commit.
4. **Consume.** `rank.yml` and `ranked-run.yml` resolve the digest for the requested
   `harness-ref` with `scripts/ranked/resolve-image.mjs`. `rank.yml` reads
   `results/_harness.json` from the harness repo's default branch and runs the resolver
   from the tag checkout it has already verified; `ranked-run.yml` reads both from the
   commit it runs from. The resolver fails unless exactly one object entry matches and
   its commit equals the checked-out harness commit. The workflow then verifies the image
   attestation (the command below, with the checked-out commit), pulls the image by
   digest and runs it by digest. Tags are never used.
5. **Attest the result.** Besides the usual provenance attestation, each ranked run signs
   a second attestation over its report with predicate type
   `https://github.com/ORG_PLACEHOLDER/x402-redteam/blob/main/docs/seasons.md#which-image-ran-this-result`
   and predicate `{"image": "ghcr.io/<org>/x402-redteam-ranked@sha256:…",
   "harness_commit": "<40 hex>"}`. `report.json` itself is unchanged.

To check a result yourself:

```sh
# Which image produced this report?
gh attestation verify results/<id>.json --repo <org>/x402-redteam \
  --predicate-type https://github.com/ORG_PLACEHOLDER/x402-redteam/blob/main/docs/seasons.md#which-image-ran-this-result \
  --format json --jq '.[].verificationResult.statement.predicate'
# Was that image built by this repository's release workflow, from that commit on main?
gh attestation verify oci://ghcr.io/<org>/x402-redteam-ranked@sha256:<digest> \
  --bundle-from-oci \
  --repo <org>/x402-redteam \
  --signer-workflow <org>/x402-redteam/.github/workflows/release-image.yml \
  --signer-digest <harness commit> \
  --source-digest <harness commit> \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

Removing a bad image means deleting its entry from `results/_harness.json` (ADR-024);
results produced with it move to "Rejected".

## The org placeholder

The GitHub org/repo layout (a public harness repo, a private held-out corpus repo, and
the `ranked` environment with maintainer-only reviewers) is a Phase C user decision that
hasn't happened yet — **nothing has been created or pushed**. Every place this repo's
own workflows need to name that layout uses one of two parameterized forms instead of a
hardcoded org name, so there is exactly one place to update once the org exists:

- `.github/workflows/rank.yml` and `.github/workflows/ranked-run.yml` name the harness
  repo and its image as `ORG_PLACEHOLDER/x402-redteam` and
  `ghcr.io/ORG_PLACEHOLDER/x402-redteam-ranked` (job-level `HARNESS_REPO` and
  `RANKED_IMAGE`, plus `rank.yml`'s harness checkouts). Replace both once the public repo
  exists; the image path must be lowercase, because GHCR image names are.
- `.github/workflows/ranked-run.yml`'s held-out corpus checkout uses the repository
  variable `vars.HELDOUT_REPO` (format `org/repo`) — set it once in the repo's own
  Settings → Secrets and variables → Actions, after the private corpus repo exists.

## Season log

| Season | Starts | Ends | `seed_commitment` | Revealed seed | Held-out corpus merged |
|---|---|---|---|---|---|
| _none yet_ | | | | | |
