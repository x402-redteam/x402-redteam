# U24-A — Governance files, PR hygiene and held-out guard · Functional Design

Author: senior-architect · Implementer: one Sonnet developer · Bolt 7 **Phase 0** (no org needed)
Contract: ADR-017, ADR-027. Size: about half a day.

## 1. Goal
The repository has the documents and checks a reviewer expects from a well-run security project. Each one states the solo, AI-assisted reality plainly instead of implying a team.

## 2. Files (owned; one owner per file, see the Bolt 7 table)
```
SECURITY.md                         scope (harness bugs, leaderboard gaming/forgery, held-out leakage, workflow vulns, SDK findings via
                                    coordinated disclosure), how to report (GitHub private vulnerability reporting; fallback contact =
                                    OWNER_CONTACT placeholder), ack ≤ 7 days, fix target 90 days, supported versions = latest minor,
                                    safe harbour, no bounty, "do not open public issues for held-out corpus content"
CODE_OF_CONDUCT.md                  Contributor Covenant 3.0 verbatim, enforcement contact = OWNER_CONTACT placeholder
GOVERNANCE.md                       maintainer-led model; roles (maintainer, ranked-run operator, season-key custodian, contributor);
                                    "How this project is built": AI agents (architect/developer/reviewer roles in .claude/agents/) under
                                    one human's gates, audit trail in aidlc-docs/; what that does NOT give you (no independent human
                                    review; CODEOWNERS unenforceable solo; ranked environment self-approval); decision process (ADRs);
                                    access continuity / succession (placeholder for owner decision); how to become a maintainer
SUPPORT.md                          where to ask (Discussions vs Issues), commercial audits contact placeholder, no SLA for free support
.github/ISSUE_TEMPLATE/config.yml   blank issues off; contact links: security → private reporting; questions → Discussions
.github/ISSUE_TEMPLATE/bug.yml      version/commit, command, exit code, report.json excerpt, OS/Node
.github/ISSUE_TEMPLATE/scenario.yml PUBLIC corpus proposals only; banner: "ideas you want kept for a held-out season — use private
                                    reporting instead"
.github/ISSUE_TEMPLATE/leaderboard.yml  Tier 2 submission tracking (links to CONTRIBUTING)
.github/PULL_REQUEST_TEMPLATE.md    what/why, linked design or ADR, tests run, checklist: Conventional-Commit title, DCO sign-off,
                                    no held-out content, LEADERBOARD.md regenerated if results/ changed
.github/CODEOWNERS                  add `* @OWNER_HANDLE` default + keep the four results/_*.json lines; placeholder replaced in U24-H
.github/workflows/pr-hygiene.yml    on pull_request: (1) PR title matches Conventional Commits regex (types per ADR-017 §3);
                                    (2) every non-maintainer commit has Signed-off-by matching author; title passed via env:, script in
                                    scripts/pr-hygiene.mjs; permissions: {} + pull-requests: read; no pull_request_target
scripts/pr-hygiene.mjs              pure functions checkTitle(title), checkSignoff(commits[]) + thin CLI reading GitHub event JSON
scripts/heldout-guard.mjs           ADR-027 §1 local hook: denylist at $X402_HELDOUT_DIR/.denylist (default ~/x402-redteam-heldout/.denylist);
                                    absent → exit 0 silently; match → exit 1 printing FILE AND LINE NUMBER ONLY, never the matched text
scripts/heldout-guard-ci.mjs        ADR-027 §2: tokenise changed files, HMAC-SHA256 with $HELDOUT_GUARD_KEY, compare to
                                    .github/heldout-guard.hmac; key absent → "skipped (no key)" exit 0
.github/heldout-guard.hmac          empty list now (orchestrator fills it in U24-H, privately generated)
.github/workflows/heldout-guard.yml push to main + pull_request (same-repo only: if head.repo == repo); environment: guard
CONTRIBUTING.md                     ONLY a new top section "Development workflow" (branch → PR, Conventional Commit titles, DCO
                                    `git commit -s`, squash merge, running checks, opt-in hooks). Leaderboard section untouched (U24-E owns its
                                    tag examples).
package.json                        ONLY a "prepare-hooks" script (git config core.hooksPath .githooks) — coordinate: U24-B owns the rest
.githooks/pre-commit, pre-push      call scripts/heldout-guard.mjs
scripts/test/*.test.ts (or packages-level vitest project "scripts") unit tests below
```

## 3. Acceptance (developer; each < 1 min)
- `pnpm lint && pnpm typecheck && pnpm test` are green. The tests for `scripts/` are picked up by the vitest projects; add `"scripts"` to `vitest.config.ts` projects (U24-A owns that line).
- `checkTitle`: accepts `feat(cli): x`, `fix!: y` and `corpus: add …`; rejects `Update stuff`, `feat:` with an empty subject, and unknown types.
- `checkSignoff`: missing, mismatched-email and maintainer-exempt cases.
- `heldout-guard.mjs` with a temp denylist containing `zzcanary` and a staged file containing it → exit 1. **stdout and stderr must not contain `zzcanary`** (asserted). Denylist absent → exit 0 with no output.
- `heldout-guard-ci.mjs`: with a key, a known token is detected through the HMAC list; without a key → skipped, exit 0. The committed HMAC fixture for tests uses a test key, never the real one.
- `pr-hygiene.yml` and `heldout-guard.yml` parse (existing YAML test pattern), have `permissions: {}` at top level, and contain zero `${{ }}` inside `run:` (reuse the action-yaml test helper).

## 4. Orchestrator-only
- Fill `OWNER_CONTACT` and `OWNER_HANDLE` after owner decisions D3 and D1 (U24-H).
- Generate the real denylist and HMAC list from the held-out corpus. The developer never sees the held-out directory.
- Enable private vulnerability reporting and Discussions (U24-H bootstrap).

## 5. Do not
- Read `~/x402-redteam-heldout/` or any held-out file. Use synthetic denylists in tests.
- Add husky, commitlint, or any third-party GitHub Action or app.
- Claim human code review anywhere. Claim response SLAs other than those above.
- Edit README, workflows other than the two new ones, or the leaderboard section of CONTRIBUTING.
