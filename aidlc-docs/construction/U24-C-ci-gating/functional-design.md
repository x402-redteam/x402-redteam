# U24-C — CI gating: PR, main and nightly · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 0b** (after U24-B merges; parallel with U24-A and U24-D)
Contract: ADR-018. Size: about one day.

## 1. Goal
- One required check, `ci-ok`. PRs get a fast gate always and the heavy suites when runtime paths change.
- Main gets everything. Nightly covers the matrix, Python, audit and the ranked dry run.
- No double runs. Least privilege everywhere.

## 2. Files (owned in Phase 0b)
```
.github/workflows/ci.yml        rewrite:
  on: pull_request; push: branches [main]; workflow_dispatch
  permissions: {}; concurrency: group ci-${{ github.ref }}, cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
  jobs:
    changes      contents: read; outputs runtime=true|false via `git diff --name-only "$BASE" "$HEAD"` (env vars, no ${{ }} in run)
                 against the ADR-018 §1 path list; push to main → always true
    fast         lint, typecheck, `pnpm test:coverage`, `pnpm -r build` into a temp outDir (CI must prove packages build),
                 leaderboard diff — timeout 15
    host-resolution  (existing job, unchanged logic) — timeout 10
    e2e          needs changes; if runtime == 'true'; existing 6-shard matrix — timeout 60
    self-test    MOVED here from self-test.yml as a reusable call (`uses: ./.github/workflows/self-test.yml`) gated on runtime
    ci-ok        needs [changes, fast, host-resolution, e2e, self-test]; if: always(); fails if any needs.*.result is
                 failure|cancelled (skipped is OK)
.github/workflows/self-test.yml on: workflow_call + workflow_dispatch only (no push/pull_request); permissions: {} + job contents: read;
                                timeout-minutes 30; matrix unchanged
.github/workflows/nightly.yml   NEW: schedule (daily 17:00 UTC) + workflow_dispatch
  unit-matrix   ubuntu × node [22, 24, 26] + macos-latest × node 24: install + `pnpm test`
  e2e-full      `pnpm test:e2e` on one runner (single invocation, as documented) — timeout 60
  python-agent  build examples/agents-py uv venv (astral-sh/setup-uv pinned by SHA from the U24-D table) and run the python-agent
                test (removes the skip in CI only: env X402_REQUIRE_PY_VENV=1 makes the test fail instead of skip)
  audit         `pnpm audit --prod --audit-level high`
  ranked-dry    calls the U22 checklist item 7 dummy-season path WITHOUT secrets (test seed + 3-scenario dummy corpus from
                packages/cli/test/fixtures); if that path needs the `ranked` environment, stub this job and leave a TODO for U24-F
  report        if: failure(); issues: write; `gh issue` create-or-comment on one issue titled "Nightly failure" (env-only inputs)
package.json                    add scripts: "test:coverage" (vitest run --coverage, same excludes as test) — coordinate line ownership
                                with U24-A/E via the orchestrator (B has finished by then)
vitest.config.ts                coverage block: provider v8, include packages/*/src/** and examples/*/src/**, reporters text-summary +
                                json-summary + lcov, thresholds = measured − 2 per metric (fill after first run), output coverage/
                                (already gitignored)
packages/cli/test/action-yaml.test.ts  update shard-sync test for the new ci.yml shape; add: every workflow has top-level permissions,
                                every job has timeout-minutes, every checkout has persist-credentials: false, no `push:` without
                                branches filter
examples/agents/test/python-agent.test.ts  honour X402_REQUIRE_PY_VENV (fail instead of skip when set)
```
**Dependency:** `@vitest/coverage-v8`, exact version matching vitest 5.0.2. This is a lockfile change. The orchestrator approves the version, and the 3-day `minimumReleaseAge` applies.

Use the action SHAs from the U24-D pin table (checkout v7.0.1, setup-node v7.0.0, pnpm/action-setup v6.1.0, setup-python v7.0.0). Don't invent pins.

## 3. Acceptance (developer; each < 3 min)
- `pnpm lint && pnpm typecheck && pnpm test` green; `pnpm test:coverage` runs in under 2 min and prints the summary. Record the measured baseline in the unit report, then set thresholds.
- The YAML structure tests above pass. `ci-ok` `needs` contains every other job (test).
- There is a unit test of the path classifier, extracted to `scripts/ci-changes.mjs` with a pure `isRuntimePath(path)`.

## 4. Orchestrator-only
- Run the real thing once the repo exists (Phase 2). Record durations for the docs-only PR path and the code PR path, plus the first nightly, in audit.md.
- Make `ci-ok` (not individual jobs) the required check in the ruleset (U24-H).
- Approve the coverage dependency version.

## 5. Do not
- Add third-party path-filter or "alls-green" actions.
- Run two E2E suites in one job.
- Put `${{ }}` inside any `run:`.
- Touch `rank.yml`, `ranked-run.yml`, `verify-results.yml` or `action.yml`.
