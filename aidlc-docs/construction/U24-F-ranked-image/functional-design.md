# U24-F — Ranked image: build once per release, GHCR by digest, attest, SBOM, pull-by-digest · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 0c** (after U24-D; parallel with U24-E)
Contract: ADR-023, ADR-024; amends the U19 "build fresh per run" choice. Size: about one day.

## 1. Goal
Every ranked or verified result names an image digest that an outsider can pull and verify with `gh attestation verify oci://…`. The digest is produced by this repo's `release.yml`.

## 2. Pins (taken from github/github-mcp-server `docker-publish.yml`, 2026-10-07; NOT re-verified by tag; the orchestrator verifies them)
docker/setup-buildx-action v4.4.1 `f87e5991a6d7451dcb8d9637bfbc97413f497069` · docker/login-action v4.6.0 `dbcb813823bdd20940b903addbd779551569679f` ·
docker/metadata-action v6.2.0 `dc802804100637a589fabce1cb79ff13a1411302` · docker/build-push-action v7.4.0 `c3c9e263c25d99ce0380d002d59b67737d91b0dc`.

## 3. Files (owned in Phase 0c)
```
.github/workflows/release-image.yml (NEW, workflow_call only, input version)
  job image: environment release; permissions contents: read, packages: write, id-token: write, attestations: write
  buildx; login ghcr with GITHUB_TOKEN; metadata tags vX.Y.Z, vX.Y, vX (no latest pre-1.0); build-push platforms linux/amd64,
  build-args HARNESS_COMMIT=$GITHUB_SHA, sbom: true, provenance: mode=max; actions/attest subject-name ghcr.io/<org>/x402-redteam-ranked,
  subject-digest from build output, push-to-registry: true; write digest to the job summary and as an output
.github/ranked/Dockerfile           keep logic; add OCI labels (org.opencontainers.image.source/revision/version via build args);
                                    apt: pin package versions where Debian bookworm makes that practical, else document why not
.github/workflows/rank.yml, ranked-run.yml   replace `docker build` with: input/env `RANKED_IMAGE_DIGEST` resolved from
                                    results/_harness.json for the requested harness-ref (a small node script, not inline jq with ${{ }});
                                    `gh attestation verify "oci://$IMAGE@$DIGEST" --repo <org>/x402-redteam
                                    --signer-workflow <org>/x402-redteam/.github/workflows/release-image.yml`; `docker pull` by digest;
                                    run as today. Record the digest in the attestation subject metadata / report config passthrough
                                    already used for harness_commit (no schema change: put it in the attestation predicate, not report.json)
results/_harness.json               schema extension: { "allow": [ { "commit": "...", "version": "vX.Y.Z", "image": "sha256:..." } ] }
                                    with backward-compatible reader (plain string entries still accepted, but rank workflows require
                                    the object form)
packages/leaderboard/src/…harness allowlist reader    accept both forms; tests
scripts/ranked/resolve-image.mjs    pure resolveImage(harnessJson, ref) → digest | error
packages/cli/test/ranked-workflows.test.ts           update: no `docker build` in rank/ranked-run; pull by @sha256 only; verify
                                    step precedes run; release-image.yml permissions minimal
docs/seasons.md                     "Which image ran this result" section
```
**Contract note:** `_harness.json` shape is a leaderboard contract change. That needs architect sign-off, given here (ADR-023), plus an audit entry by the orchestrator.

## 4. Acceptance (developer; each < 1 min)
- `pnpm lint && pnpm typecheck && pnpm test` green.
- `resolveImage`: found, unknown ref, string-form entry rejected for ranked use, malformed digest.
- Leaderboard reader accepts both forms, and the existing results produce identical `LEADERBOARD.md`.
- Workflow structure tests above. No `${{ }}` in `run:`.

## 5. Orchestrator-only
- Verify the four docker action SHAs. Phase 2: the first image build from `release.yml`. Then `docker`-free verification: `gh attestation verify oci://…` from the laptop. Then the U22 checklist items 6–7 re-run against the pulled image.
- Decision D7: image visibility (public recommended).

## 6. Do not
- Push images or run docker locally (CLAUDE.md).
- Add cosign as a second signing path.
- Change `report.json`.
