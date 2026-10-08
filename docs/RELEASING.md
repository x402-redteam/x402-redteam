# Releasing

Maintainer runbook for cutting a release (ADR-021, ADR-024). One version covers the whole
repository; a release is a reviewed PR plus one environment approval, and nothing is tagged
or published from a laptop.

## One-time repository setup

- **Immutable releases** enabled in the repository settings. A published release locks its
  `vX.Y.Z` tag and assets.
- **`release` environment.** Its approval is the security gate for every release:
  - required reviewer: the owner;
  - "Allow administrators to bypass configured protection rules" **disabled**;
  - deployment branches: `main` only;
  - no secrets (the workflow uses OIDC and `GITHUB_TOKEN`).

  The ranked image job (`release-image.yml`) has no environment of its own; it runs only after
  the approved `release` job, so a release needs one approval.
- **Tag ruleset** scoped to the major tags only (`v0`, `v1`, ... e.g. the patterns `v[0-9]` and
  `v[0-9][0-9]`): create, update and delete restricted to the release workflow's identity.
  Release tags (`vX.Y.Z`) need no ruleset entry because immutable releases already lock them.
  If the ruleset is widened to `v*`, both publishing the release (which creates `vX.Y.Z`) and
  the major-tag move need the bypass identity.
- **Confirm in the first dry run:** `GITHUB_TOKEN` may be refused when it creates or moves a
  ref to a commit that changes files under `.github/workflows/` (that needs the `workflows`
  permission, which `GITHUB_TOKEN` can't have). If the `major-tag` job fails that way, use a
  GitHub App token for it, or move the tag by hand (see below).
- **Squash merge** enabled for pull requests: the release commit's subject must be
  `chore(release): vX.Y.Z` (GitHub's ` (#123)` suffix is fine), merged from a branch whose
  name starts with `release/v`. The `release` job refuses any other commit.

## Steps

1. **Prepare.** On `main`, clean and equal to `origin/main`:

   ```bash
   pnpm release:prepare 0.1.0
   ```

   This fetches tags from `origin`, refuses to run off `main`, on a `main` that differs from
   `origin/main`, or when `v0.1.0` already exists. It writes `0.1.0` into every
   `package.json`, adds the `0.1.0` section to `CHANGELOG.md` from the Conventional Commits
   since the last release tag (a section already written by hand is kept), then creates
   branch `release/v0.1.0`, commits `chore(release): v0.1.0` and prints the push and
   `gh pr create` commands. Any failure restores the working tree. It never pushes.

2. **Edit the changelog.** Review the generated section, set its date, and make sure it says
   when the corpus changed (old results become stale) or a reference score moved.

3. **Regenerate the reference results.** `harness_version` is part of every report, so the
   committed `results/*.json` and `LEADERBOARD.md` change with the version. Regenerate them on
   the release branch, run `pnpm leaderboard`, run the E2E suite once, and commit.

4. **Open the PR** with the printed commands and let CI pass. `pnpm release:notes 0.1.0`
   prints the section that becomes the release notes.

5. **Squash-merge.** `release.yml` sees the release commit on `main`, runs the full CI gate
   on it, and waits for approval in the `release` environment. Don't merge anything else to
   `main` until the release job has run: the SBOM comes from GitHub's dependency graph and
   describes the default branch at the moment the job runs.

6. **Approve the deployment.** Before approving, check in the run that the commit is the
   squash merge of a `release/vX.Y.Z` PR opened by a maintainer, and that its diff is the
   version bump, the changelog and the regenerated results. The `release` job then:
   - checks every `package.json` carries the version and that the commit was merged into
     `main` from a `release/v*` pull request;
   - stops if a draft, a tag or a release for `v0.1.0` already exists at another commit, and
     skips straight to the next jobs if `v0.1.0` is already published at this commit;
   - builds the source archive, the release notes and the SPDX SBOM;
   - attests build provenance for the archive and the SBOM, and the SBOM for the archive,
     and writes each Sigstore bundle as a `*.sigstore.json` asset;
   - creates a **draft** release with every asset, then publishes it, which makes it
     immutable and creates the `v0.1.0` tag at the release commit.

   Then, in parallel:
   - `major-tag` moves the major tag (`v0`) to the release commit;
   - `image` builds, pushes and attests the ranked image (`release-image.yml`). Its job
     summary shows the image digest and the `results/_harness.json` entry.

7. **Record the harness.** Open a follow-up PR adding the entry from the image job's summary
   (release commit, version and image digest) to `results/_harness.json`. That file is where
   the README tells users to take the digest from. It can't be part of the release commit,
   because that commit's SHA isn't known before merge.

8. **Verify** with the commands in the README's "Verify a release" section, then announce.

## When something fails

- **Re-running is safe.** Use "Re-run failed jobs". If `v0.1.0` is already published at the
  release commit, the `release` job skips building and publishing and the `major-tag` and
  `image` jobs run again on their own.
- **The major-tag move fails** (for example the workflow-file limitation above): move it by
  hand with a token that may update the tag, then re-check `uses: <org>/x402-redteam@v0`:

  ```bash
  gh api -X PATCH "repos/<org>/x402-redteam/git/refs/tags/v0" -f sha=<release commit> -F force=true
  ```

- **Before publication** (CI, the checks, an attestation or the draft): delete any leftover
  draft release, then open the fix from a `release/vX.Y.Z-fix` branch as a PR titled
  `chore(release): vX.Y.Z` for the same version. Squash-merging it makes the fix commit the
  new release commit.
- **After publication:** a published release's tag and assets can't be changed. Supersede it
  with `vX.Y.(Z+1)`, move the major tag back to the last good release if the new one isn't
  ready, and mark the bad release in its notes. A bad image digest is removed from
  `results/_harness.json`, and results produced with it move to "Rejected" with a reason.
