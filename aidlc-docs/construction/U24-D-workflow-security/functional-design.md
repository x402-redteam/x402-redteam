# U24-D — Workflow security, update automation and action pins · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 0b** (after U24-B; parallel with U24-A and U24-C)
Contract: ADR-019, ADR-026 (Scorecard). Size: about one day.

## 1. Goal
- Every action is on a current, Node-24-runtime major, pinned by SHA.
- Dependabot keeps those pins, the pnpm lockfile and the ranked base image current, with a cooldown.
- CodeQL, zizmor, actionlint and Scorecard run and publish.
- Review findings H3 and M5 are fully closed.

## 2. Pin table (verified against the GitHub API on 2026-10-07 by the architect; the orchestrator re-verifies at merge)
| Action | Tag | Commit SHA | Notes |
|---|---|---|---|
| actions/checkout | v7.0.1 | 3d3c42e5aac5ba805825da76410c181273ba90b1 | same pin vitest uses |
| actions/setup-node | v7.0.0 | 820762786026740c76f36085b0efc47a31fe5020 | read the v5–v7 notes: `package-manager-cache` default changed in v5 (unverified; check) |
| pnpm/action-setup | v6.1.0 | ea17c68df8912ef543352723c149a84f56e3d413 | `runs.using: node24` (read at that SHA) |
| actions/setup-python | v7.0.0 | 5fda3b95a4ea91299a34e894583c3862153e4b97 | |
| actions/upload-artifact | v7.0.1 | 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a | check pairing with download v8 |
| actions/download-artifact | v8.0.1 | 3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c | |
| actions/attest | v4.2.2 | 1e69f48acb82d1966a394da916b4c1698aa569d6 | replaces attest-build-provenance (v4 of that is a wrapper) — input names differ; read README |
| github/codeql-action/* | v4.38.2 | 2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 | upload-sarif in action.yml + codeql.yml init/analyze |
| ossf/scorecard-action | v2.4.4 | 2d1146689b8cda280b9bc96326124645441f03bc | |
| zizmorcore/zizmor-action | v0.6.4 | cc914d7f3750a2d13d75c7f184a1060aa0e9d482 | same pin vitest uses |
| astral-sh/setup-uv | v10.2.0 | c18668ad3cf93ea998bef934396af7bb5c839dc7 | for U24-C nightly python job |
| rhysd/actionlint (binary) | v1.7.12 | release asset + its published checksum | sha256 to be recorded by the orchestrator (not verified here) |

Release-only pins for U24-E/F are in U24-F §2. They come from github/github-mcp-server and were not re-verified by tag.

## 3. Files (owned in Phase 0b)
```
.github/dependabot.yml          version 2; updates:
  - github-actions  directories ["/", "/.github/workflows"]  weekly, group "actions" (all), cooldown default-days 7, semver-major-days 14
  - npm             directory "/" (pnpm lockfile)            weekly, groups: "x402" (@x402/*) EXCLUDED from auto-grouping and
                    labelled `needs-adr-007` (CLAUDE.md: bump deliberately), "dev" (devDependencies), "prod" (rest);
                    ignore typescript major (TS 7 hold), ignore @types/node major; cooldown 7/14; open-pull-requests-limit 5
  - docker          directory "/.github/ranked"               weekly, cooldown 7
.github/workflows/codeql.yml    on PR, push main, weekly; permissions {} + job security-events: write, contents: read, actions: read;
                                matrix language [javascript-typescript, actions, python]; build-mode none; queries security-extended
.github/workflows/scorecard.yml on push main, weekly, branch_protection_rule; per ossf/scorecard-action README: job permissions
                                security-events: write, id-token: write, contents: read, actions: read; publish_results: true;
                                upload SARIF; persist-credentials false
.github/workflows/zizmor.yml    as vitest (persona pedantic, SARIF); plus actionlint step (download pinned binary, verify sha256 from
                                a constant in the workflow, run on .github/workflows/*.yml)
.github/zizmor.yml              config; any ignore needs a one-line justification comment (expect: none, or the reusable
                                rank.yml's documented inputs)
action.yml                      ONLY `uses:` pin lines (setup-node, upload-sarif, upload-artifact) — node-version already 24 (U24-B)
.github/workflows/{rank,ranked-run,verify-results}.yml   ONLY `uses:` pin lines; attest-build-provenance → actions/attest with
                                equivalent inputs (subject-path / subject-digest); verify-results already node 24 (U24-B)
packages/cli/test/action-yaml.test.ts, ranked-workflows.test.ts   ONLY assertions that hard-code old tags/SHAs, plus a NEW test
                                file packages/cli/test/pins.test.ts: every `uses:` in action.yml and .github/workflows/** is either
                                `./…` or `owner/repo[/path]@<40-hex> # vX.Y.Z`; no attest-build-provenance; no node20-era majors
                                (checkout@v4, setup-node@v4, upload-artifact@v4, codeql-action@v3) by comment
```
**File contention:** U24-C owns `ci.yml` and `self-test.yml` and applies the same table there. `action-yaml.test.ts` is shared with U24-C, so U24-D edits only the pin-related assertions and the orchestrator merges U24-C first.

## 4. Acceptance (developer; each < 1 min)
- `pnpm lint && pnpm typecheck && pnpm test` green, including `pins.test.ts`.
- `dependabot.yml` parses and its schema is spot-checked in a unit test (keys `version: 2`, three ecosystems, cooldown present).
- New workflows have top-level `permissions: {}`, per-job grants only, and zero `${{ }}` in `run:`.

## 5. Orchestrator-only
- Re-verify every SHA in §2 against the GitHub API (`get_tag` / `list_tags`) at merge time. Record the actionlint checksum.
- Locally, without installs, do nothing more. zizmor, actionlint, CodeQL and Scorecard first execute in Phase 2 on GitHub. Their first findings become follow-up issues, triaged within the same bolt.
- Optional local run: `uvx zizmor .github/workflows` only if the owner approves uvx use (decision D10).

## 6. Do not
- Use tags or branches instead of SHAs. Pin anything not in the table without asking the orchestrator.
- Enable Dependabot auto-merge (solo maintainer: each update PR is the review record).
- Touch triggers or jobs of `ci.yml`/`self-test.yml` (U24-C) or the ranked workflow logic (U24-F).
