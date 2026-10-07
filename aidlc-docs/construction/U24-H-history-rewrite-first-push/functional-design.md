# U24-H — History rewrite, first push and repository bootstrap (ORCHESTRATOR-ONLY) · Runbook

Author: senior-architect · Executor: **the orchestrator only**. No Sonnet developer. It touches the held-out denylist and needs the owner's say-so to push. Bolt 7 **Phase 1 → 2**.
Contract: ADR-025, ADR-017, ADR-019 §7, ADR-024, ADR-027. Every command below prints **counts, SHAs or paths only**, never matched text.

## 0. Preconditions
- Phase 0 units are merged, and main is green locally: install, lint, typecheck, test, plus one quiet `test:e2e`.
- The owner has made decisions D1 (org/repo name), D2 (rewrite vs orphan), D3 (contacts) and D10 (`uvx git-filter-repo==2.47.0`; git here is 2.38.1, so confirm filter-repo's minimum git version first).
- **CLAUDE.md is edited first**: the "orphan commit" sentence becomes "published history is the ADR-025 rewrite; never push the original local repository". Then HEAD contains that edit and the tree-equality check below covers it.

## 1. Build the denylist (private; never in the repo; never printed)
`$S=$X402_HELDOUT_DIR/.publish` (mode 700). A script there (not in the repo) writes:
- `denylist.txt`:
  - every held-out scenario `id`, every rendered `{{host:…}}` value, every canary and every distinctive mechanism token, taken from the season corpus YAML;
  - the 4 original sensitive lines of `aidlc-docs/audit.md`, extracted from `git show 4250300 -- aidlc-docs/audit.md` and `git show 13fc9b3 -- aidlc-docs/audit.md` (the `-` lines);
  - the personal account number and bank detail as standalone tokens.
- `expressions.txt` (filter-repo `--replace-text` format): `literal:<original line>==><the line as it reads in HEAD>` for the 3 redactions; for the personal line, `==>` the placeholder that commit 13fc9b3 then deletes. Choose a placeholder that keeps that commit non-empty, e.g. `- [entry removed: unrelated to the project]`.
- Self-check, printing counts only: `grep -c . denylist.txt`; every expression's left side occurs in at least one historical blob (`git log -S` count ≥ 1).

## 2. Pre-scan the original repository (counts only)
```
git rev-list --all | wc -l                               # expect 128 + Phase-0 commits
for c in $(git rev-list --all); do git grep -l -F -f "$S/denylist.txt" "$c" -- . ; done | sed 's/^[^:]*://' | sort | uniq -c
git log --all --format=%B | grep -c -F -f "$S/denylist.txt"   # commit-message hits (expect 0; if >0 add --replace-message)
```
**Expected:** hits only in `aidlc-docs/audit.md`, in at most 82 commits. **Any other path → STOP**, inspect it privately, extend `expressions.txt`, and log the count and path in audit.md (never the text).

**Removed-lines review** (ADR-025 §3): for `aidlc-docs/**` and `CLAUDE.md`, list every line present in any historical version but absent from HEAD, using `git log -p --all -- <paths>` `-` lines minus HEAD's lines. Write it to `$S/removed-lines.txt` and grep it with the denylist. Read it privately to catch paraphrases. Record only the count.

## 3. Rewrite on a mirror (never on the working repo)
```
git clone --no-local --mirror /Users/a15202/git/x402-redteam "$S/mirror.git"
cd "$S/mirror.git"
uvx git-filter-repo==2.47.0 --sensitive-data-removal --replace-text "$S/expressions.txt" [--replace-message "$S/expressions.txt"]
```

## 4. Verify (all must hold; record each result in audit.md)
1. **Tree equality:** `git -C mirror rev-parse main^{tree}` == `git -C original rev-parse main^{tree}`.
2. **Shape:** commit count equal (filter-repo prunes commits that become empty, so if one is pruned, explain it). `git log --format='%an%x09%ae%x09%ad%x09%s'` is identical before and after (diff = empty). Co-Authored-By trailer counts are identical (81/17/8 today, plus Phase 0).
3. **Zero hits, all objects:** `git cat-file --batch-all-objects --batch | grep -c -a -F -f "$S/denylist.txt"` → 0 in the mirror.
4. **Fresh clone:** `git clone --no-local "$S/mirror.git" "$S/verify"`, then repeat check 3 in `$S/verify`. `git fsck --full` passes.
5. **It still works:** in `$S/verify`: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`.
6. Old SHAs referenced in docs (for example "4250300" in audit.md and the review) now point at rewritten commits. Add one audit.md line mapping old → new for the cited SHAs, or accept the stale references and note it. Recommended: a mapping table, generated from filter-repo's `filter-repo/commit-map`.

## 5. Placeholder substitution (in `$S/verify`, as one normal commit)
Replace `ORG_PLACEHOLDER`, `OWNER_HANDLE` and `OWNER_CONTACT` (D1/D3) everywhere they appear: CODEOWNERS, provenance.ts, rank.yml, CONTRIBUTING, README badges, SECURITY, CoC. Then run `pnpm test`. Re-run check 3 on the new commit only.

## 6. First push (owner's explicit go-ahead required)
- The owner creates the org and an **empty** public repo: no README, licence or template; 2FA required for org members.
- `git -C "$S/verify" push origin main` from the **verified clone only**. Push no tags.
- Clone from GitHub into `$S/gh` and repeat check 3. GitHub secret scanning runs on push; look at the Security tab.
- Archive the original local repository offline (owner). It must never get a remote. Remove the `$S` work dirs except `denylist.txt`.

## 7. Bootstrap settings (immediately after the push; `gh api` calls kept as a script in `$S`, results pasted to audit.md)
- **General:** squash-merge only (title = PR title), auto-delete head branches, Discussions on, wiki off, Projects off.
- **Security:** private vulnerability reporting; secret scanning plus push protection; Dependabot alerts and security updates; code scanning via the U24-D workflows (not default setup, to avoid two configurations).
- **Rulesets:**
  - `main`: ADR-017 §1, with required check `ci-ok`, plus `codeql (javascript-typescript)`, `zizmor` and `pr-hygiene`;
  - tags `v*`: restrict create, update and delete to the release identity (D6);
  - immutable releases enabled.
- **Environments:**
  - `release`: reviewer owner, branch main;
  - `ranked`: reviewers per D4, branch main, secrets `SEASON_SEED` and `AGE_KEY` (owner enters them; the orchestrator never sees the values);
  - `guard`: secret `HELDOUT_GUARD_KEY`;
  - `github-pages`: only if D9.
- Commit `.github/heldout-guard.hmac`, generated privately from the denylist with `HELDOUT_GUARD_KEY`. That's a separate PR: the first PR through the new ruleset, and it doubles as the ruleset's smoke test.
- **Actions:** "allow only SHA-pinned actions" (org policy, if available; unverified), default workflow permissions read-only, and "Allow GitHub Actions to create and approve pull requests" off.

## 8. Phase 2 evidence to collect (feeds G8)
- Real-runner checklist U22 items 1–8.
- First Scorecard result (score plus per-check, saved).
- First CodeQL and zizmor findings, triaged.
- First nightly.
- `v0.1.0` release plus `gh release verify` and `gh attestation verify` outputs for the assets and the image.
- Best Practices "passing" self-assessment, submitted by the owner's account (the orchestrator drafts the answers in `aidlc-docs/reviews/bestpractices-answers.md`).
