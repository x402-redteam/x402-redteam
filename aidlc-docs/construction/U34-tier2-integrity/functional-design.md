# U34 — Tier 2 integrity and ranked-container hardening (functional design, rev 2)

Follow-up 1 of `aidlc-docs/reviews/consulting-architecture-review.md` (H1, H2, M6). Owner
decisions (2026-10-31): Tier 2 becomes unranked; hardening verified by a local image build and
run; `rank.yml` runs with `--network none`. Rev 2 folds in
`aidlc-docs/reviews/architecture-review-u34.md` (changes required; A1–A10).

## 1. H1 — the attested report must be the one the run produced

Today `rank.yml`'s `attest` job downloads the artifact `report-<id>` by name and attests it
(`rank.yml:210-235`). The caller workflow belongs to the submitter, so another job in the same run
can replace the artifact between upload and download.

### 1.1 Workflows (both `rank.yml` and `ranked-run.yml`)

1. In the `run` job, after the container exits and ownership is reconciled, a step refuses a
   missing, symlinked or non-regular report file, computes its `sha256sum` (`report.json` for
   Tier 2, `report.redacted.json` for Tier 1) and writes it to `GITHUB_OUTPUT`; the job exposes it
   as `outputs.report-sha256`. The upload step's `artifact-id` is also exposed and `attest`
   downloads by that id (A10).
2. In `attest`, before any attestation step, a step validates the expected value against
   `^[0-9a-f]{64}$`, checks the downloaded file with `sha256sum -c`, and fails on any mismatch.
   The value reaches the script only through `env:` (A10).
3. `rank.yml`'s `attest` gains the 40-hex harness-commit check `ranked-run.yml` already has (A10).
4. The second attestation's predicate also records `report_sha256`.

Job outputs are written only by the job's own steps, so the caller cannot set them; the remaining
caller moves (concurrency, re-running a job, pre-uploading a same-named artifact) are denial of
service only (review, H1).

### 1.2 Leaderboard: accept only attestations from a fixed `rank.yml` (A1)

The caller chooses the `rank.yml` version (`uses: …/rank.yml@<ref>`) independently of
`harness-ref`, and the Tier 2 check today pins only the signer workflow path
(`packages/leaderboard/src/provenance.ts:103-119`). An attestation from a pre-U34 `rank.yml` would
still verify. So:

- Tier 2 verification passes `--signer-digest <report.config.harness_commit>` and requires a
  signer ref matching `refs/tags/v*` (the workflow must be the one at the same release tag the
  report was produced by).
- A Tier 2 report is accepted only when its `harness_commit` is a release listed in
  `results/_harness.json` at or after the first release containing U34 (a `min_tier2_release`
  field there, set when that release is cut). Until then no Tier 2 report is accepted, which is
  already the case since U31.
- Tests: the gh argument builder emits both constraints for Tier 2; a report whose commit is
  before `min_tier2_release` is rejected with a reason.

## 2. H2 — Tier 2 is not a ranking

- `build-leaderboard.ts`: Tier 2 rows sort by id (`compareCodeUnits`), like reference rows; `#`
  is a display ordinal. Section intro: "Not ranked: the public corpus and seed are known in
  advance, so this is a regression result. Only Tier 1 (held-out corpus, secret season seed) is
  ranked." The page header (`:970-976`, "Both tables … ranked by safety score") and the Tier 2 row
  comment (`:122`) are corrected (A9).
- The existing test pinning Tier 2 safety order (`build-leaderboard.test.ts:1287-1288`) is
  rewritten to pin id order (A9).
- Docs: README leaderboard section (and its stale "same-job tampering" residual, `README.md:512-515`),
  ADR-011 amendment (also retiring the stale residual at `decisions.md:196,210`), and the
  regression-result wording in `docs/seasons.md` and `CONTRIBUTING.md` (A9).
- `LEADERBOARD.md` regenerated (Tier 2 is empty today, so only text changes).

## 3. M6 — harden the ranked containers

Both `docker run` invocations become:

```
--network none
--cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add DAC_OVERRIDE
--security-opt no-new-privileges
--pids-limit 512 --memory 4g --memory-swap 4g
--read-only
--tmpfs /tmp:rw,size=1g --tmpfs /root-out:rw,mode=0700,size=256m --tmpfs /corpus:rw,mode=0700,size=256m
```

- Capabilities, with reasons (review): CHOWN for the per-run HOME, task and GDP dirs; SETUID and
  SETGID for the uid drop at spawn; KILL for `kill(-pid)` and `pkill -u 2001`; DAC_OVERRIDE for
  root reading and removing 0700 dirs owned by 2001 and writing into the runner-owned `/out`.
  Adjusted only if §4 proves one unnecessary or another required, with the reason recorded.
- `entrypoint.sh`: `tar -x --no-same-owner --no-same-permissions` so the held-out corpus is
  root-owned as ADR-011 states (A3); an explicit `chmod 0700 /root-out` (A5).
- `rank.yml` gains `--network none` (it had bridge networking). A guardrail must not fetch at
  run time; dependencies are committed or vendored. CONTRIBUTING.md documents it; CHANGELOG marks
  it breaking for submitters (A6).
- Job timeouts: `timeout-minutes: 30` on `rank.yml`'s `run` job and `45` on `ranked-run.yml`'s
  job (A8).
- The flags apply to whatever image the allowlist resolves. Because the entrypoint changes, they
  take effect with the next release image (v0.1.1); until then no Tier 1 or Tier 2 run is
  accepted anyway (A4).

## 4. Local verification (owner-approved)

Run under Docker Desktop with Rosetta for amd64 (A8); any timed-out scenario invalidates a
comparison and is recorded.

1. Build the image from HEAD: `docker build --platform linux/amd64 -f .github/ranked/Dockerfile .`
   (pulls the digest-pinned base image and the sha256-checked `age` tarball).
2. **Tier 2 shape:** run as `rank.yml` will, hardened, on the public corpus with the reference
   guardrail and `--agent-uid 2001`; then once without the hardening flags. Same exit code and
   `report.json` minus `timing` byte-identical.
3. **Tier 1 shape (A3):** encrypt the public corpus with a throwaway `age` key generated in the
   scratch directory, run as `ranked-run.yml` will (`--user 0:0`, `AGE_KEY`, a throwaway
   `SEASON_SEED`, `--redact`), hardened and unhardened. Same exit code and identical
   `report.redacted.json`; the decrypted corpus is root-owned, mode 0400/0500.
4. **Negative checks (A7):** a throwaway guardrail that attempts an outbound connection fails to
   connect; one that fork-bombs is contained by the pids limit, and the run still completes later
   scenarios and writes a full report (if not, wrap the agent with `prlimit --nproc`; never
   `--ulimit nproc`). Throwaway guardrails live in the scratch directory, not the repo.
5. Record in `audit.md`: final capability set and reasons, run times, identical-report results,
   negative-check results.

## 5. Files

```
.github/workflows/rank.yml, .github/workflows/ranked-run.yml, .github/ranked/entrypoint.sh
packages/leaderboard/src/{build-leaderboard,provenance}.ts (+ tests); results/_harness.json schema
packages/cli/test/ranked-workflows.test.ts   pins §1.1 and §3 (digest output, regex check,
                                             check-before-attest order, env-only passing,
                                             artifact-id download, flags, tmpfs modes, timeouts)
docs/seasons.md, CONTRIBUTING.md, README.md, LEADERBOARD.md, CHANGELOG.md
aidlc-docs/inception/adr/decisions.md        ADR-011 amendment
```

## 6. Acceptance

1. Workflow and leaderboard tests pin every item in §1–§3.
2. §4 evidence recorded in `audit.md`.
3. The usual re-run: install, lint, typecheck, unit with coverage, fuzz guard, leaderboard, e2e.

## 7. Not in scope

A live Actions dry run (needs the real org and a release); per-run Tier 2 seeds; the CI job that
builds the image on PRs (follow-up 9); cutting v0.1.1 itself (follow-up 2, owner push).

### Build conditions (delta check, architecture-review-u34.md)

C1–C5 as listed in the review's "Delta check (rev 2)". C1 decision: the Tier 2 signer identity
regex accepts `rank.yml@refs/tags/vX.Y.Z` or `rank.yml@<40-hex sha>`; the signer-digest check
ties either to an allowlisted release commit. CONTRIBUTING.md says so.

### Owner decisions (2026-10-31)

1. Tier 2 attestations accepted from a tag or a commit-SHA pin of `rank.yml` (C1).
2. Rev 2 approved for build; local commits only.
3. The orchestrator may start Docker Desktop for the §4 checks.
