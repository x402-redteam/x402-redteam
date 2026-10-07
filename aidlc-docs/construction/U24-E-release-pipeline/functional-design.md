# U24-E — Versioning, changelog, release workflow and Action packaging · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 0c** (after U24-C and U24-D merge; parallel with U24-F)
Contract: ADR-021, ADR-022 §1–2, ADR-024. Size: about 1.5 days.

## 1. Goal
- `pnpm release:prepare 0.1.0` produces a reviewable release PR.
- Merging it, plus one environment approval, produces a signed, immutable GitHub Release with an SBOM and attestation bundles, a moved major tag, and (via U24-F) an attested image.
- The Action installs only production dependencies and carries Marketplace branding.

## 2. Files (owned in Phase 0c)
```
package.json                      "version": "0.1.0-dev" (single source of truth) + scripts "release:prepare", "release:notes"
packages/*/package.json, examples/*/package.json   "version" field only, kept equal by the sync script (private stays true)
packages/cli/src/version.ts (NEW) export HARNESS_VERSION read from the root package.json at build/run time (import attributes
                                  `with { type: "json" }` or fs read relative to the module)
packages/cli/src/run.ts           ONLY line 564: default harness_version = HARNESS_VERSION (replaces the "0.0.1" constant)
scripts/release/version.mjs       syncVersions(root, version): validates ^\d+\.\d+\.\d+$ (no v), writes every package.json
scripts/release/changelog.mjs     pure: (commits[{sha,subject,body}], version, date) → Keep-a-Changelog section; groups feat/fix/
                                  corpus/season/perf/security; "BREAKING CHANGE" / "!" → Breaking section; skips chore/ci/docs/test
                                  unless flagged; prepends to CHANGELOG.md
scripts/release/prepare.mjs       release:prepare X.Y.Z: clean tree check → branch release/vX.Y.Z → syncVersions → changelog since
                                  last v* tag (or root commit) → print the PR command (`gh pr create --title "chore(release): vX.Y.Z"`).
                                  Never pushes by itself (CLAUDE.md: pushing needs the user's say-so)
scripts/release/notes.mjs         release:notes X.Y.Z → extracts that section from CHANGELOG.md to stdout (used by release.yml)
scripts/release/detect.mjs        pure isReleaseCommit(subject, version) — "chore(release): v" + version, prefix match (PR-number suffix)
CHANGELOG.md (NEW)                header + "Unreleased" + a hand-written 0.1.0 entry seeded from the bolt history (orchestrator edits text)
.github/workflows/release.yml (NEW)
  on: push: branches [main]; permissions: {}
  detect    contents: read; checkout (persist-credentials false, fetch-depth 0); outputs release/version via detect.mjs (env only)
  verify    needs detect, if release; uses: ./.github/workflows/ci.yml (workflow_call added by agreement with U24-C — orchestrator
            applies that one-line trigger) — full gate on the exact commit
  release   needs verify; environment: release; permissions contents: write, id-token: write, attestations: write
            steps: assert tag absent; assert package.json version == detected; SBOM via
            `gh api repos/$GITHUB_REPOSITORY/dependency-graph/sbom --jq .sbom > sbom.spdx.json`;
            actions/attest (sbom predicate, subject = sbom file) and provenance attestation over the asset set; write each bundle to
            <asset>.sigstore.json; `gh release create "v$V" --draft --target "$GITHUB_SHA" --notes-file notes.md` + upload assets
            + bundles; then `gh release edit "v$V" --draft=false` (publish → immutable); move major tag
            (`git tag -f "v${V%%.*}" && git push -f origin "refs/tags/v${MAJOR}"`) — token per owner decision D6
  image     needs release; delegated: `uses: ./.github/workflows/release-image.yml` (U24-F owns that file)
action.yml                        `branding: { icon: shield, color: red }` (check the Feather icon name against the docs); install step →
                                  `pnpm install --frozen-lockfile --prod --ignore-scripts`; README/permissions comments unchanged otherwise
README.md                         sections owned: badges row (6 badges per ADR-026; org placeholders), "Install" (Action + clone; npx
                                  removed until ADR-022 B), "Verify a release" (gh release verify / gh attestation verify commands for
                                  assets and the image digest), "Versioning" (what SemVer covers, ADR-021 §2)
CONTRIBUTING.md                   leaderboard section ONLY: tag examples → v0.1.0 (rank.yml regex), ORG_PLACEHOLDER untouched
docs/RELEASING.md (NEW)           maintainer runbook: prepare → orchestrator regenerates reference results with the new
                                  harness_version (they change bytes) → PR → merge → approve `release` env → post-release PR adding
                                  the commit to results/_harness.json → announce; rollback per ADR-024
scripts/test/release-*.test.ts    tests below
```

## 3. Acceptance (developer; each < 1 min)
- `pnpm lint && pnpm typecheck && pnpm test` green.
- `syncVersions` rejects `v1.0.0`, `1.0` and `1.0.0-rc.1` (no pre-releases in v0.x; revisit later), and writes all files identically.
- `changelog` table tests: feat, fix, breaking `!`, a corpus change, skipped chore, and a body with `BREAKING CHANGE:`.
- `isReleaseCommit`: exact, with the ` (#12)` suffix, wrong version, and a plain `chore: release` without the version.
- `release:notes` round-trips the section written by `changelog`.
- `release.yml` structure test: the release job has `environment: release`; the top level has `permissions: {}`; there is no `${{ }}` in `run:`; draft → publish order (a regex on step order).
- A report produced with the new default carries `harness_version` equal to the root version (unit test on the run-config builder, no E2E).

## 4. Orchestrator-only
- Regenerate `results/*.json` and `LEADERBOARD.md`, because `harness_version` changes the bytes. Run E2E once.
- Phase 2: enable immutable releases; create the `release` environment; set up the tag ruleset or App per D6; do the first real `v0.1.0` release; run `gh release verify v0.1.0` and `gh attestation verify` on every asset; record the outputs in audit.md.

## 5. Do not
- Push, tag or create releases locally.
- Publish to npm (U24-G, conditional).
- Add release-please, changesets, semantic-release or git-cliff.
- Edit `ci.yml`. Its `workflow_call` trigger line is applied by the orchestrator to avoid U24-C conflicts.
