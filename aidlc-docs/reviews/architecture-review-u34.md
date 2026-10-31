# Architecture review — U34 functional design rev 1 (Tier 2 integrity, container hardening)

Reviewer: senior architect (read-only). Inputs: `construction/U34-tier2-integrity/functional-design.md`,
`reviews/consulting-architecture-review.md` H1/H2/M6, `rank.yml`, `ranked-run.yml`, `.github/ranked/*`,
`cli/src/{run,spawn,guardrail-track}.ts`, `leaderboard/src/{build-leaderboard,provenance}.ts`.

## Verdict: CHANGES REQUIRED (rev 2), then approve. Direction right; A1–A4 are blocking.

The digest hand-off is right for both workflows, and the attest job does attest the bytes it checked.
But the fix only helps if the leaderboard refuses attestations from the old `rank.yml`, and the caller
chooses that version. The planned starting capability set will fail. Only the Tier 2 path gets verified.

## H1 — what the caller can and cannot reach
- Job outputs: the caller cannot write `run`'s outputs. They are set only by `run`'s own steps
  (`rank.yml:67-70,152-155`). The caller supplies inputs only. `guardrail-id` is regex-checked
  before use (`:84-92`). Workflow-level `env` is not passed to a called workflow. `concurrency`
  and re-runs only get the caller a denial of service. Re-running `attest` alone reuses attempt 1's
  outputs, so a swapped artifact still fails the check. Pre-uploading `report-<id>` makes `run`'s
  upload fail (no `overwrite`), which is also DoS only. The real attack is a later overwrite or
  delete followed by a re-upload, and the `sha256sum -c` check catches it.
- Bytes: `attest` checks `out/report.json` and attests that same path in the same job. No
  untrusted code runs in that job. OK. The same fix is right for `ranked-run.yml:233-260`, as
  defence in depth (maintainer-run, `--redact` file).

## Findings
| id | sev | evidence | required change |
|---|---|---|---|
| A1 | High | The caller picks the `rank.yml` version (`uses: …rank.yml@<any ref>`, CONTRIBUTING.md:48). That ref is independent of `harness-ref` (`rank.yml:42`). Tier 2 verification checks only the signer path, plus `--signer-digest` when one is given (`provenance.ts:112-116`). It has no ref check, and `verifyEntries` gets no digest. An attestation from `rank.yml@v0.1.0` or any pre-U34 SHA therefore still verifies, and the artifact swap stays open. HIGH-5's subject hash only ties the committed file to whatever was attested. | In `--verify-attestations` Tier 2, pass `--signer-digest <report.config.harness_commit>` (ties the `rank.yml` version to the harness-ref, which is allowlisted) and require a `refs/tags/v*` signer ref (`--cert-identity-regex`). Accept Tier 2 only from releases at or after U34: mark eligible entries in `_harness.json`, or drop v0.1.0 from Tier 2. Add tests in `provenance.test.ts`. Optionally also check that the second predicate's `report_sha256` equals the subject. |
| A2 | High | The starting set `CHOWN SETUID SETGID KILL` (§4.4) lacks DAC_OVERRIDE, which is needed in three places. (1) The per-run HOME and GDP dirs come from `mkdtemp` (mode 0700) and are chowned to 2001 (`run.ts:395-396,449-451`). Root then reads `gdp.json` from them and `rmSync`s them (`:486,505,531`). (2) `entrypoint.sh:69,72` copies the report into `/out`, a directory the runner (uid 1001, 0755) created (`rank.yml:190`, `ranked-run.yml:204`). (3) In Tier 1, root reads 0400 corpus files that `tar` gives non-root owners (A3). | Predicted set: **CHOWN, SETUID, SETGID, KILL, DAC_OVERRIDE**. Reasons: CHOWN for chown of HOME/tasks/record dirs. SETUID and SETGID for libuv setgroups/setgid/setuid in `spawn.ts:147-148`. KILL for `process.kill(-pid)` and `pkill -9 -u 2001` across uids (`spawn.ts:73`). DAC_OVERRIDE as above. Not needed: NET_BIND_SERVICE (loopback ephemeral ports, which the empirical run should confirm), NET_RAW, MKNOD, SYS_CHROOT, SETFCAP, AUDIT_WRITE, FSETID. Start the empirical run from this set. A missing cap can surface as "exited 0 but left no GDP record" (`run.ts:509-514`) rather than a crash. The byte-identical acceptance catches that, so keep it. |
| A3 | High | §4 tests only Tier 2 (no `AGE_KEY`). Tier 1's `--user 0:0`, decrypt branch, `--redact` and seed path never run hardened. GNU `tar` as root keeps the archive's owner and mode by default (`entrypoint.sh:46`). The `chmod -R 0400` that follows (`:50-51`) then needs FOWNER on files owned by the maintainer's uid. It also means the corpus is not root-owned as ADR-011 claims. | Change to `tar --no-same-owner --no-same-permissions` (Tier 1 then needs no FOWNER). Add §4 step 2b: a throwaway age key, the public corpus tarred and encrypted, a dummy `SEASON_SEED`, run exactly as `ranked-run.yml` does, hardened against unhardened, and compare `report.redacted.json`. |
| A4 | Med | Workflow flags are applied to whichever image `_harness.json` resolves (`rank.yml:144-155`). Today that is v0.1.0 (`results/_harness.json`), not the locally built HEAD. If A3 or A5 changes the image, the workflows need a new release. | State that the flags must work on every allowlisted image, or tie U34 to follow-up 2 (v0.1.1 plus allowlist). `release-image.yml` itself is unchanged. |
| A5 | Med | `--read-only` is feasible. Run-time writes go to `/root-out` and `/corpus` (both at `/`), `/tmp` (entrypoint `mktemp`, `os.tmpdir()` for HOME/GDP/tasks, tsx cache `/tmp/tsx-<uid>`) and the `/out` bind mount. Nothing writes under `/harness` or `/root`. Two traps. Docker tmpfs defaults to mode 1777, and `mkdir -m 0700 -p` (`entrypoint.sh:56`) does not fix an existing dir, so `/root-out` would be writable by the agent. tmpfs pages also count toward `--memory`. | If adopted: `--tmpfs /tmp:size=512m --tmpfs /root-out:mode=0700,size=64m`, plus `--tmpfs /corpus:mode=0700` for Tier 1, and an explicit `chmod 0700 /root-out` in entrypoint. The default `noexec` on tmpfs is fine (tsx output is loaded, not exec'd), but say so. |
| A6 | Med | `--network none` on `rank.yml` breaks any submitter guardrail that fetches at run time (`npx`, `pnpm` via corepack under the new HOME, LLM APIs). `/workspace` is read-only (`rank.yml:195`) and the job runs no install step, so dependencies must be committed or the guardrail must have none. The negative check covers only a deliberate connect. | Document the contract in CONTRIBUTING.md Tier 2 (no network, read-only checkout, vendored deps, node builtins), with a CHANGELOG "breaking for submitters" note. The reference guardrail run in §4 is the positive check. |
| A7 | Med | Fork bomb vs `--pids-limit 512`. Threads count toward the limit (~11 per node process; harness, tsx, driver and guardrail ≈ 50). Exhaustion can make the root harness's own spawn or `pkill` fail with EAGAIN. Those failures are swallowed (`spawn.ts:82`), so the next scenario's spawn fails too. | Keep 512 (or 1024). Strengthen §4.5: after the bomb scenario the harness still writes a complete report, and later scenarios still run. If not, wrap the agent in `prlimit --nproc` (util-linux is in the base image). Do not use `--ulimit nproc`: for container root it counts host-wide uid 0. `--memory 4g --memory-swap 4g` is sensible on a 16 GB runner. `no-new-privileges` breaks nothing: privileges drop by syscall, and no setuid binary is exec'd. It also neuters `su`/`passwd` in bookworm-slim. |
| A8 | Med | Emulation: `age` is hard-wired to linux-amd64 (`Dockerfile:28`), so Apple Silicon must emulate. Under QEMU, node's JIT is several times slower, which risks `startup_timeout_s 120` / `timeout_s 60` (`canonical.ts:12-13`). That gives spurious `timed_out` runs, a flaky identical-report check, and a measured time unrepresentative of `ubuntu-latest`. | Use Docker Desktop's Rosetta. Record any `timed_out` run (one invalidates the comparison). Do not derive `timeout-minutes` from the emulated time: use a fixed 30 (Tier 2) / 45 (Tier 1) and record the local figure as context. |
| A9 | Low | H2 knock-on effects beyond §2. The page header still says "Both tables … ranked by safety score" (`build-leaderboard.ts:970-976`). The row comment `:122`. The existing test pins Tier 2 safety order (`build-leaderboard.test.ts:1287-1288`) and must be rewritten, not just added to. README:512-515 and ADR-011 (`decisions.md:196,210`) still name "same-job tampering" as the Tier 2 residual, which is stale since U27 and closed by H1. docs/seasons.md:23 and CONTRIBUTING.md:32 already say "only Tier 1 is ranked", so they need only the regression-result wording. | Add these to §2 and §5. In the ADR amendment, the residual becomes "public seed, fit-able; unranked". |
| A10 | Low | `rank.yml`'s attest lacks the 40-hex `HARNESS_COMMIT` check that `ranked-run.yml:271-274` has. The digest step should refuse a symlink or non-regular file. `sha256sum -c` needs a `"<hash>  <path>"` line built from env. | Add the check. Use `test -f && ! test -L` before hashing. Validate the expected value against `^[0-9a-f]{64}$`, not just for non-empty. Optional: pass `upload-artifact`'s `artifact-id` output to `download-artifact` `artifact-ids:`. Pin all of these in `ranked-workflows.test.ts`. |

## Not missing
`release-image.yml` builds only and needs no change (unless A3/A5 change the image, see A4). The
leaderboard's subject-hash check (`build-leaderboard.ts:1078,1124`) composes correctly with H1 once
A1 pins the signer version.

## Delta check (rev 2)

**Verdict: SIGNED OFF FOR BUILD, with build conditions C1–C5.** A2–A10 are resolved as written
(§1.1, §2, §3, §4). A1 is resolved in intent, but the gh flags need correcting (C1, C2).

| finding | rev 2 | status |
|---|---|---|
| A1 | §1.2 adds `--signer-digest` plus a signer-ref constraint plus `min_tier2_release`. | Resolved, subject to C1–C3. |
| A2 | §3 caps are CHOWN, SETUID, SETGID, KILL and DAC_OVERRIDE, each with a reason. | Resolved. |
| A3 | `tar --no-same-owner --no-same-permissions`; §4.3 adds a Tier 1 local run. | Resolved. |
| A4 | §3: the flags take effect with the v0.1.1 image. | Resolved. |
| A5 | `--read-only` with tmpfs modes, plus an explicit `chmod 0700 /root-out`. | Resolved. |
| A6 | `--network none`; CONTRIBUTING and CHANGELOG notes. | Resolved. |
| A7 | §4.4 adds the after-bomb check; `prlimit` fallback; no `--ulimit nproc`. | Resolved. |
| A8 | Rosetta; fixed 30/45 min timeouts; a timed-out run invalidates the comparison. | Resolved. |
| A9 | Header, row comment, test rewrite, README and ADR stale residual. | Resolved. |
| A10 | Symlink and regular-file guard, regex check, 40-hex check, download by `artifact-id`. | Resolved, subject to C5. |

**`--signer-digest` is the right flag.** For a reusable workflow, the certificate's Build Signer
Digest is the called workflow's own commit (`job_workflow_sha`), not the caller's. gh's
`--signer-digest` checks exactly that value. The `--source-*` flags describe the caller and must
not be used for Tier 2 (`provenance.ts:112` correctly omits `--source-ref`).

**There is no `--signer-ref` flag.** `--signer-workflow` (`provenance.ts:112`) matches the workflow
path at *any* ref. The ref is checked through the certificate SAN with `--cert-identity-regex`.
In gh, that flag is mutually exclusive with `--signer-workflow`, so for Tier 2 it *replaces*
`--signer-workflow`.

**`/corpus` tmpfs with `--read-only` works for Tier 1.** The pieces fit as follows:
- `mkdir -p` is a no-op on the mount, `tar` extracts into it, and the final `find … chmod 0500`
  includes `/corpus` itself (`entrypoint.sh:50-51`).
- The age identity and the decrypted tar go to `/tmp` (1g) and are removed before the harness
  starts. Peak RAM is about 2x the corpus size, well inside 4g.
- In Tier 2 the mount is unused (`CORPUS_DIR=/harness/corpus`), so it is harmless.
- Default `noexec` and `nosuid` are fine, because nothing in `/corpus` or `/tmp` is executed.

Build conditions:
- **C1.** The Tier 2 gh arguments become:
  `--owner <submitter> --cert-identity-regex '^https://github\.com/x402-redteam/x402-redteam/\.github/workflows/rank\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' --signer-digest <harness_commit>`.
  - Derive the regex from `HARNESS_ORG_REPO` with the dots escaped and anchored at both ends.
  - Update `provenance.test.ts:50-51`, which pins `--signer-workflow` for Tier 2.
  - Tier 1 keeps `--repo`, `--signer-workflow` and `--source-ref` (`provenance.ts:106-107`).
  - Decide and document tag-only refs. Consumers who pin `uses:` by SHA (Scorecard style) get a
    `@<sha>` SAN and would be refused. The digest is the binding control, so the regex may also
    accept `@[0-9a-f]{40}`. Either choice is acceptable, but CONTRIBUTING.md must say which.
- **C2.** Define `min_tier2_release` precisely:
  - It is a `vX.Y.Z` that must itself name an object-form `allow` entry.
  - A report is Tier 2-eligible only if its `harness_commit` matches an object-form entry whose
    `version` is semver-greater than or equal to it.
  - Plain-commit entries, an absent field, or `["*"]` mean no Tier 2.
  - Enforce it offline in `buildLeaderboard` with a rejection reason, not only in
    `--verify-attestations`.
  - `resolve-image.mjs` reads only `allow` (`:34-45`). Add a test that it tolerates the new field.
- **C3.** `verifyEntries` takes `signerDigest` from the candidate report's `config.harness_commit`,
  validated as `^[0-9a-f]{40}$` first. A missing or invalid value means the candidate is skipped,
  as with no owner.
- **C4.** §4.2 and §4.3 "unhardened" means the workflows' current flags exactly. §4.3 also asserts
  that `/root-out` and `/corpus` are 0700/0500 root-owned on tmpfs, and that `report.redacted.json`
  is the only file in `/out`.
- **C5.** `attest` downloads with `artifact-ids:` only (no `name:`). Both workflows' run jobs expose
  `artifact-id` and `report-sha256` as outputs. `ranked-workflows.test.ts` pins both.
