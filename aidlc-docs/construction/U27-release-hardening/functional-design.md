# U27: Release hardening for v0.1.0

Revision 1 (2026-10-14). Source: senior-architect read-only triage of the 53 open code-scanning alerts and 21 Dependabot alerts on main (9e1c7b5). Owner decisions (2026-10-14): Bolt 9 closed; release prep before Bolt 10; D6 option A (GITHUB_TOKEN, manual major-tag move as fallback).

## 1. Code fixes (true positives, all low impact)
1. `action.yml` (zizmor github-env, the composite Action's only error): write the artifact directory to `$GITHUB_OUTPUT` from a step with an `id`, and read it as a step output where `GITHUB_ENV` is used now.
2. `.github/workflows/ranked-run.yml` (zizmor excessive-permissions): top-level `permissions: contents: read`; move `id-token: write` and `attestations: write` into a separate attest job, as `rank.yml` already does, so the job that runs the guardrail never holds the attestation token.
3. `packages/leaderboard/src/build-leaderboard.ts` `escapeCell` (CodeQL incomplete-sanitization): escape backslashes before pipes. `guardrail_id` and `agent_id` in the results schema are restricted to `^[a-z0-9][a-z0-9._-]{0,63}$`; existing committed results must still validate (check every id in `results/`). Contract change, recorded in application-design.md.
4. `packages/driver/src/intent.ts` (CodeQL polynomial-redos): replace the sentence-split regex with a linear one (e.g. `/(?<![.!?])[.!?]+(?=\s|$)/`), with tests showing identical splits on the corpus.
5. `packages/driver/src/main.ts:65`: rewrite `/^X402_|_RPC_URL$/i` as `/^(?:X402_.*|.*_RPC_URL)$/i` (same meaning, explicit).

## 2. Workflow hygiene (zizmor notes, in bulk)
- `name:` on every job (anonymous-definition).
- A short comment on every `permissions:` entry stating why it is needed (undocumented-permissions).
- `concurrency:` with `cancel-in-progress: false` on `release.yml`, `verify-results.yml` and `ranked-run.yml` (ranked runs grouped per guardrail id).
- `self-repository` notes: keep `./` local-action references; disable that rule in `.github/zizmor.yml` with a comment.
- actionlint and zizmor must pass; the pins test must still pass.

## 3. Third-party adapter dependencies (Dependabot)
- `examples/third-party/agentkit/pnpm-workspace.yaml` `overrides` (not `package.json`: with pnpm 10, `pnpm.overrides` in package.json makes pnpm ignore the workspace overrides that pin `@x402/*`) for the patched transitive versions (ws, uuid, stream-json, decode-uri-component, bn.js, elliptic and bigint-buffer where a patched version exists), keeping `@coinbase/agentkit` 0.10.4 and the targeted `@x402` versions; regenerate its lockfile. The adapter's canary and exit-code tests must pass.
- `examples/third-party/agentkit/bracket-2.0.0/`: no overrides (the old versions are the point of the comparison). Add a README line and an `osv-scanner.toml` with `[[IgnoredVulns]]` entries and the reason; the orchestrator dismisses those alerts as tolerable risk after merge.

## 4. Docs
- `docs/RELEASING.md`: D6 option A, and the triggers for moving to a GitHub App: more than one release a month for two months, the manual major-tag move needed on three releases, or a second maintainer who should release without the owner's token.
- CHANGELOG: an Unreleased line for the leaderboard id restriction and escaping.

## 5. Not code (owner or orchestrator after merge)
- Dismiss the false positives with the triage's reasons (CodeQL spawn.ts, gdp.ts, rank.yml untrusted checkout, host-env.ts, shim evm/svm, pr-hygiene.mjs, three test regexes).
- Owner: OpenSSF Best Practices self-assessment and badge; branch protection refinements; Scorecard "Code Review" and "Maintained" are accepted for a one-maintainer project.

## 6. Acceptance
lint, typecheck, unit tests, test:e2e, `pnpm leaderboard` unchanged, naive exit 1 and guarded exit 0; actionlint and zizmor clean of errors; CodeQL alerts for items 1-5 closed on the PR's scan.
