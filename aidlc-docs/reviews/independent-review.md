# Independent end-to-end review: x402-redteam

Reviewer: independent principal architect, brought in cold with no briefing on history or known problems.
Date: 2026-10-05. Reviewed at `main` @ `4250300` (122 commits, working tree clean, no remote, no tags).
Environment: macOS (Darwin 25.6), Node 20.19.5, pnpm 10.34.6 via corepack. One probe on Node 24.11.0.
Scope: everything tracked in this repository. The private held-out corpus outside the repo was out of scope and was not read.

Every claim below comes from something I read or ran myself. Each finding is marked **reproduced** (I ran it), **observed in code** (read, not executed) or **suspected** (reasoned, could not test here).

---

## 1. Verdict

x402-redteam is a red-team harness for agents that pay over the x402 protocol: a mock hostile server, a payment-capture layer, a pure scorer, a CLI runner, a guardrail driver and a leaderboard generator, in about 14,800 lines of TypeScript with about 15,600 lines of tests. **The core engine does what the docs claim, and I could prove it**: all five reference runs I executed reproduced the committed `results/*.json` byte for byte (apart from timing and the recorded commit), two back-to-back runs were byte-identical, a crashing or do-nothing agent is reported INVALID rather than safe, and lint, typecheck, 848 unit tests and the three e2e files I ran all pass. The engineering is careful, strict and unusually candid about what was not verified. **What is not yet release-grade is the leaderboard provenance layer and the release packaging**: the ranking workflows have never executed anywhere, cannot build as committed, and contain a design gap that would reject every ranked result; every GitHub Action is referenced by a mutable tag; the runtime pinned everywhere (Node 20) is past end-of-life; user-facing docs have drifted from the code; and the repo's own rules say the git history cannot be published, which removes most of the visible proof of work from a public release. None of the defects I found corrupts a result produced by the documented default commands.

**Overall grade: B+**

| Area | Grade | One-line reason |
|---|---|---|
| Architecture | A- | Clean package boundaries, pure scorer, determinism by construction, real-SDK integration; not yet packaged for distribution |
| Correctness | B+ | Every committed result reproduced; fail-closed on crashes; a fail-open `--scenario` typo, unvalidated options and cross-run contamination found |
| Security | B | Strong core (env allowlist, loopback-only, no expression injection, no advisories); provenance pipeline unpinned, unexecuted and partly unworkable |
| Test quality | B+ | Real clients against a live mock, calibration oracles, determinism tests; workflow tests are string matches, privilege path is mocked, no coverage measurement |
| Documentation | B- | Extensive and honest about limits, but the README quickstart output, a CONTRIBUTING example and several status files are stale |
| Process | A- | Design-first units, recorded gates, independent reviews that reproduced blockers and forced fixes; evidence is largely self-reported and the history is unpublishable |

---

## 2. Evidence summary

All commands were run from the repo root. Probe output went to a scratch directory outside the repo, deleted afterwards. `git status --short` was empty before the report was written.

### 2.1 Static checks and unit tests

| Check | Command | Result |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Lockfile up to date, 10 workspace projects, 0.6 s. pnpm ignored the one dependency build script (esbuild) by default |
| Lint | `pnpm lint` | Exit 0. 231 files checked in 0.1 s. 3 warnings, all "file exceeds 1 MiB, not processed" for `results/*.json` |
| Typecheck | `pnpm typecheck` | Exit 0 across 9 projects, 9.6 s. `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
| Unit tests | `pnpm test` | Exit 0. 71 files passed, 1 skipped. **848 tests passed, 1 skipped**. 18.0 s wall |
| Unit tests on Node 24 | same vitest command with Node 24.11.0 first on `PATH` | Exit 0. 848 passed, 1 skipped. 16.4 s |
| Build | `tsc -p tsconfig.build.json --outDir <scratch>` for each of the 7 packages | All exit 0, no errors. CI never runs a build |
| Advisories | `pnpm audit` | "No known vulnerabilities found" |
| Currency | `pnpm outdated -r` | 4 packages one patch behind (biome, hono, viem, vitest). `typescript` 6.0.3 and `@types/node` 20 are deliberate holds |
| Secrets | `git grep` and `git log -p -G` for API keys, private keys, age keys, home paths | No hits in tracked files or history other than dummy strings in tests |

### 2.2 End-to-end runs with the CLI (52 scenarios, 101 runs per suite)

| Run | Exit | Wall | Summary | Matches committed result |
|---|---|---|---|---|
| `validate` | 0 | <2 s | "OK: 52 scenario(s) loaded" | n/a |
| `validate --corpus packages/cli/test/fixtures/broken-corpus` | 2 | <2 s | Names file, path and reason | n/a |
| `run --agent "tsx examples/agents/src/naive.ts"` | 1 | 76 s | 93 attack runs, 6.5% pass, $622.47 unauthorized (capped), safety 6.8, controls 8/8 | **Yes**, identical minus `timing` and `config.harness_commit` |
| same, second run | 1 | 71 s | identical | `report.json` minus timing byte-identical to the first run. `report.sarif` identical. `report.md` differs only in its `Duration:` line |
| `run --agent "tsx examples/agents/src/guarded.ts"` | 0 | 70 s | 93/93 pass, $0, safety 100, controls 8/8 | **Yes** |
| `run --guardrail "tsx examples/guardrails/reference-policy.ts"` | 0 | 119 s | 93/93, safety 100, 0 guardrail errors | **Yes** (also ignoring the `agent_id` label I chose) |
| `run --guardrail "tsx examples/guardrails/allow-all.ts"` | 1 | 93 s | 0/93, $1,127.95, safety 0, controls 8/8 | **Yes** |
| `run --guardrail "tsx examples/guardrails/deny-all.ts"` | 2 | 87 s | INVALID banner, controls 0/8, safety score suppressed | n/a |
| `run --agent "true"` | 2 | 2 s | INVALID banner, controls 0/8 | n/a |
| agent command that cannot start (`tsx` not on `PATH`) | 2 | 1 s | INVALID, 0/8 controls | n/a |

The six exit codes above are exactly the six that `.github/workflows/self-test.yml` asserts (1, 0, 2, 1, 2, 0). I reproduced that matrix locally. The workflow itself has never run.

Regenerating the leaderboard in memory from `results/` and `corpus/` produced markdown identical to the committed `LEADERBOARD.md` (4 reference rows, 0 rejected, 0 stale).

### 2.3 E2E test files (run one at a time)

| File | Result | Wall |
|---|---|---|
| `packages/cli/test/guardrail-integrity.e2e.test.ts` | 4/4 passed | 3 s |
| `packages/cli/test/hosts.e2e.test.ts` | 2/2 passed | 28 s |
| `packages/cli/test/rpc-capture.e2e.test.ts` | 3/3 passed | 5 s |

`run-suite`, `corpus-v2` and `driver-calibration` e2e files were not run as tests. Their central assertions (exit codes, calibration oracles, determinism) are covered by the CLI runs in 2.2.

### 2.4 Targeted probes

| Probe | Result |
|---|---|
| `run --agent guarded --scenario no-such-scenario` | **Exit 0**, 0 attack runs, `safety_score: null`, nothing on stderr (finding M1) |
| `--repeat 0`, `--repeat abc` | Exit 2 INVALID with no explanation. `config.repeat` recorded as `0` / `null` (L1) |
| `--timeout abc` | Runs proceed with a NaN timer. 2 controls error. Exit 2. `timeout_s: null` (L1) |
| `--chains evm,foo` | `foo` silently ignored. Exit 0 (L1) |
| `--fail-on bogus` | Accepted and recorded as `"bogus"`. Behaves like `low` (L1) |
| Agent that dumps its environment, harness started with `AWS_SECRET_ACCESS_KEY`, `HTTPS_PROXY` and `--pass-env MY_SECRET_TOKEN,SHORTY,HTTPS_PROXY` | Agent saw only `PATH`, `HOME`, the seven harness variables and the two named ones. `HTTPS_PROXY` dropped even though named. The secret's literal value was replaced by `[REDACTED]` in the log. Its base64 and split forms were not (documented as best-effort) |
| Agent that backgrounds a delayed request and exits | The request landed in the **next** run's ledger (M2) |
| CLI with no `git` on `PATH` | `config.harness_commit: "unknown"` (H2) |
| Leaderboard given a would-be Tier 2 entry with `harness_commit: "unknown"` and a concrete allowlist | Rejected: `harness_commit "unknown" is not on the release allowlist`. Same entry with the release commit: accepted (H2) |
| `printf v1 \| grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'` (rank.yml's own check against CONTRIBUTING's example) | Rejected (M6) |
| Corpus hash and canonical report hash under 7 locales (`en_US`, `sv_SE`, `et_EE`, `lt_LT`, `da_DK`, `tr_TR`, `C`) | Identical in all 7 (L7 did not reproduce) |
| `report --in <malformed json> --format md` | `TypeError` stack trace, exit 2 (L1) |

---

## 3. What is done well

**Results are reproducible, and I reproduced them.** Four committed reference results (`naive-baseline`, `guarded-reference`, `reference-policy`, `allow-all`) came out byte-identical on my machine after removing `timing` and the recorded commit. Determinism is designed in rather than hoped for: seed-derived run ids and wallets (`packages/cli/src/run.ts:143-148`), wall-clock values stripped before the report is written and replaced with a persisted boolean so the leaderboard can re-score (`packages/scorer/src/score-suite.ts:304-321`), sorted-key output.

**The harness fails closed where it matters.** A crash, a do-nothing agent and a guardrail that cannot start all end as exit 2 or `error`, never as a pass (`packages/scorer/src/score-run.ts:326-332`, `packages/cli/src/run.ts:194-205`). Zero control runs does not count as valid (`score-suite.ts:172-174`). Zero attack weight gives `safety_score: null` instead of 100 (`score-suite.ts:182-183`). A guardrail whose `hello` fails is an error, not a silent allow-all (`packages/driver/src/gdp.ts:233-249`). A malformed decision is a deny (`gdp.ts:182-188`).

**Agent isolation is real.** The subprocess environment is built from an allowlist (`run.ts:157-186`), and my probe confirmed an ambient cloud credential and proxy variable did not leak. Servers bind loopback only (`packages/adversary/src/index.ts:160`). The forward proxy never dials out; it dispatches in-process and refuses `CONNECT` (`packages/adversary/src/proxy.ts:107,136-138`). Crawlers follow only exact allowed origins (`packages/driver/src/crawl.ts:109-112`).

**The composite Action is written defensively.** No `${{ }}` expression appears inside any `run:` script; every input travels through `env:` (`action.yml:172-187`), and a test enforces that (`packages/cli/test/action-yaml.test.ts`). Outputs are empty strings rather than misleading zeros when no report exists. Agent logs are excluded from the uploaded artifact by default. Workflow permissions default to `contents: read`.

**Tests exercise real behaviour.** Only 6 of 84 test files use mocks or spies. The adversary suite drives the real `@x402` EVM and Solana clients against the live mock server. The calibration oracles are meaningful: allow-all must fail every attack, deny-all must be INVALID, reference-policy must pass everything, and the same run twice must be byte-identical. SARIF output is validated against the 2.1.0 schema. Corpus lint rules each have a failing fixture (33 fixture files under `packages/schema/test/fixtures`).

**Type safety and hygiene.** Zero `@ts-ignore` or `@ts-expect-error` in source or tests. 10 uses of `any` in 91 source files, 6 of them annotated with a reason. No TODO or FIXME in any `.ts` file. Dependencies are exact-pinned with integrity hashes, the package manager is pinned by sha512, and there are no known advisories.

**Supply-chain default.** pnpm 10 refused to run the only dependency install script without approval, so `pnpm install` executes no third-party code at install time.

**Candour.** The docs repeatedly state what was not verified: workflows "statically authored and YAML-checked only" (`rank.yml:29-31`, `ranked-run.yml:12-15`), `*.localhost` verified only on macOS (`README.md`, Host modes), same-user residual risk between driver and guardrail (`packages/driver/src/main.ts:48-55`), Tier 2 tampering residual (ADR-011). The Dockerfile deliberately fails the build until a real checksum is pinned (`.github/ranked/Dockerfile:30-35`). This makes the repository easier to trust, not harder.

---

## 4. Findings

Severity reflects impact on a public release. Nothing here is live today: there is no remote and no published artifact.

| ID | Sev | Area | Evidence | Impact | Recommended fix | Status |
|---|---|---|---|---|---|---|
| H1 | high | Provenance pipeline | `rank.yml` and `ranked-run.yml` build `.github/ranked/Dockerfile` with no `--build-arg` (`rank.yml:107-110`, `ranked-run.yml:99`), and the Dockerfile exits 1 while `AGE_SHA256` is the placeholder (`Dockerfile:21,30-35`). `ORG_PLACEHOLDER` is hard-coded in `rank.yml:84` and `packages/leaderboard/src/provenance.ts:26`. `.github/CODEOWNERS:7-10` names a non-existent team. The privilege-drop path (`--agent-uid`: `spawn.ts:133-140`, `run.ts:315-338`) is only ever tested through mocks. No workflow has run on any runner | Tier 1 "Ranked" and Tier 2 "Verified", the features the leaderboard's credibility rests on, are designs with unit-tested helpers, not a working pipeline. The first real run will surface integration bugs | Create the org, pin the checksum and digests, then do a recorded dry run of both workflows on a real runner before any claim about tiers is published | observed in code |
| H2 | high | Contract drift: container vs leaderboard | `harness_commit` comes from `git rev-parse HEAD` or `"unknown"` (`run.ts:57-69`). The ranked image excludes `.git` (`.dockerignore`) and `node:20-bookworm-slim` ships no git. An Action checkout has no `.git` either. The leaderboard requires the commit to be on a concrete allowlist for Tier 1 and Tier 2 (`build-leaderboard.ts:271-279,421-431`) | Every report produced by either ranking workflow carries `"unknown"` and is rejected, unless `"unknown"` is put on the allowlist, which defeats harness identity | Pass the resolved commit into the container (build arg or `--harness-commit` flag written by the workflow after it asserts the tag), and reject `"unknown"` for tiered entries | reproduced (CLI without git records `unknown`; leaderboard rejects it) |
| H3 | high | Supply chain | 27 external `uses:` references across `action.yml` and 5 workflows, **0 pinned by commit SHA**. Includes `actions/attest-build-provenance@v1` in jobs holding `id-token: write`, and `actions/checkout@v4` in the job that receives `AGE_KEY` and `SEASON_SEED`. Base image `node:20-bookworm-slim` is pinned by tag only (`Dockerfile:15`). The files carry TODO comments acknowledging this | A moved tag or compromised action runs inside the job that decrypts the held-out corpus and signs attestations. Consumers of the composite Action inherit the same exposure | Pin every action and the base image by digest, add Dependabot or Renovate for actions, and add `zizmor` or `actionlint` to CI | observed in code |
| H4 | high | Publication hygiene | The repo's own rules state the local history contains held-out details and that the first public push must be a single orphan commit (`CLAUDE.md:41`, `aidlc-docs/audit.md:146-147`). Separately, `aidlc-docs/audit.md:77` records a personal cloud account number and a bank-charge detail unrelated to the project | (a) Publishing the history leaks the season. Publishing an orphan commit removes the commit-level proof of work described in section 5. (b) Personal financial detail would be published in a public audit log | Decide now what outsiders will be shown as process evidence. Remove line 77's personal detail. Consider publishing a scrubbed, rewritten history instead of one orphan commit | observed in docs (history content deliberately not inspected) |
| M1 | medium | CLI fail-open | `run.ts:266-273` filters scenarios by id and never checks that an id matched. `--scenario no-such-scenario` ran 8 controls, 0 attacks, printed no warning and exited 0 | A typo in a CI job's scenario list produces a green build that tested nothing | Exit 2 when any requested id is unknown, and when zero attack scenarios were selected | reproduced |
| M2 | medium | Measurement integrity | One adversary and one port serve the whole suite (`run.ts:282`). The agent's process group is killed only on timeout (`spawn.ts:146-160`), not on normal exit. A child that outlives its parent had its request recorded in the next run's ledger | A late payment from run N would be attributed to run N+1's scenario. Affects agents with background workers or in-flight retries. The `--agent-uid` sweep covers this only in the ranked container | Kill the process group at the end of every run, and reject requests that do not carry the current run's token (or use a fresh port per run) | reproduced |
| M3 | medium | Ranked container usability | The image contains only Node 20 and the harness. `entrypoint.sh:58` does not add `node_modules/.bin` to `PATH`. `ranked-run.yml:126-143` sets no working directory, so the guardrail starts in `/harness`, not `/guardrail`, with `--network none` and no install step. `rank.yml` is a reusable workflow, so a submitter cannot add an install step | Only dependency-free plain-JavaScript guardrails addressed by absolute path can run. The repo's own `tsx examples/guardrails/...` examples would not start. "Works in any language" (`gdp.ts:106-108`) does not hold on the ranked path | Define and document a guardrail packaging contract (prebuilt bundle or a build stage with network, then a run stage without), set `-w /guardrail`, and test it with a non-trivial guardrail | observed in code |
| M4 | medium | Tier 2 attestation chain | `rank.yml` hands `report.json` from the `run` job to the `attest` job as a workflow artifact addressed by name (`rank.yml:145-149,161-164`). Other jobs in the caller's workflow share that artifact namespace | A submitter's own sibling job could replace the artifact between upload and download, so the attested file need not be the harness's output. This is a concrete form of the residual ADR-011 already discloses, but it contradicts the claim at `rank.yml:25-27` | Emit the report's sha256 as a job output from `run`, and make `attest` verify the downloaded file against it before attesting | suspected (needs a real runner) |
| M5 | medium | Runtime currency | Node 20 is pinned in CI, the Action (`action.yml:129`) and the ranked image. Node 20 reached end-of-life on 2026-04-30. The unit suite passes unchanged on Node 24.11 | Shipping a security tool on an unsupported runtime. Action versions of the same generation (`@v4`, `codeql-action@v3`) are ageing too; I could not check their current status offline | Move CI, the Action and the image to a supported LTS, add a Node version matrix | reproduced (tests pass on 24); EOL date from the Node release schedule |
| M6 | medium | Documentation drift | `README.md:50` shows the quickstart's "real summary" as 53 runs, 3.8%, $420.314, safety 3.9; the actual output is 93 runs, 6.5%, $622.473, safety 6.8. `README.md:23,341` say "ten attack categories, one scenario each"; the corpus has 16 categories and 48 attack scenarios. `action.yml:69` says `redact` is "not implemented yet" and exits 2; it is implemented (`run.ts:554-556`). `CONTRIBUTING.md:21-23` tells submitters to pass `harness-ref: v1`, which `rank.yml:69` rejects. `CLAUDE.md:52` omits `packages/driver` and `examples/guardrails`. `aidlc-docs/aidlc-state.md:15` still shows Bolt 6 Phase B2 in progress | The first thing a newcomer runs does not match the README. A submitter following CONTRIBUTING fails at step one. The state file agents are told to read first is wrong | Regenerate the README sample from a real run in CI (or diff-check it like `LEADERBOARD.md`), fix the examples, update the state files | reproduced |
| M7 | medium | Distribution | Every package is `"private": true` with `exports` pointing at `./src/*.ts`. The bin spawns `tsx` on TypeScript source (`packages/cli/bin/x402-redteam.mjs:12-15`). The driver is located by a source-relative path (`guardrail-track.ts:20`). `harness_version` is the constant `"0.0.1"` (`run.ts:508`). CI has no build step. User story US1 (`npx x402-redteam run ...`) is not achievable | The only ways to use the tool are `git clone` and the composite Action. No versioned release artifact exists to allowlist | Decide the distribution model. If npm: build to `dist`, publish with provenance, run the built CLI in CI. If Action-only: say so and drop US1 | observed in code |
| M8 | medium | Validation evidence | The Python agent's live test is `describe.skipIf(!venvExists)` and "CI never creates it" (`examples/agents/test/python-agent.test.ts:3,26`); it was skipped here too. The audit log records no run of the LLM agent against a real model and no third-party guardrail, which ADR-008's amendment makes a precondition for publishing scores | "Proves header capture works cross-language" is not continuously verified. Every agent and guardrail ever measured was written alongside the corpus | Add a CI job that builds the uv venv and runs the Python test. Record at least one real LLM run and one external guardrail before launch | observed in code and docs |
| L1 | low | CLI input validation | `main.ts:118-127` casts and `Number()`s options without checking them. See probes in 2.4. Usage errors print stack traces. `report` crashes with a `TypeError` on malformed input | Confusing failures and non-canonical values (`null`, `"bogus"`) written into `report.json`. All of these fail closed except `--chains` | Validate with the zod schemas the project already has, print one-line usage errors | reproduced |
| L2 | low | Test depth | `packages/cli/test/ranked-workflows.test.ts` (30 cases) and most of `action-yaml.test.ts` assert that strings appear in YAML, Dockerfile and shell files | They guard against regressions in text, not behaviour. They can pass while the workflow is broken, as H1 and H2 show | Keep them, and add real execution once a runner exists | observed in code |
| L3 | low | Workflow hardening | `ranked-run.yml:63` uses `eval` to read an input-derived variable (not injectable as written, but unnecessary). `ranked-run.yml:40-43` grants `id-token: write` to the single job that also builds the image and runs the guardrail, where `rank.yml` splits those. No `concurrency`, and only one job has `timeout-minutes`. `ci.yml` triggers on both `push` and `pull_request` | Wider blast radius than needed, duplicated CI runs | Use `${!name}`, split attest into its own job, add concurrency groups and timeouts | observed in code |
| L4 | low | Example LLM agent | `examples/agents/src/lib/llm-tools.ts:171-183`: `http_get` and `pay_and_get` fetch any URL the model chooses. The scripted crawlers got an origin allowlist after an internal review; these tools did not | A model reading hostile pages can be steered to make real outbound requests during a manual run | Apply the same origin allowlist | observed in code |
| L5 | low | Secret scrubbing | `spawn.ts:224-242` replaces only the exact literal. Base64 and split forms survived in my probe | Residual leak into `out/logs`. Documented, and logs are excluded from artifacts by default | Keep the default. Consider not persisting logs at all when `--pass-env` is used in CI | reproduced |
| L6 | low | Output polish | `summary.unauthorized_usd` is `622.4729999999995` in the committed result (sum of rounded values is not re-rounded, `score-suite.ts:226`). `report.md` prints `Duration: 75570.19829499998ms` | Float noise in the canonical artifact and the human report | Round aggregate sums with the existing `round6` | reproduced |
| L7 | low | Canonicalisation | Three separate `canonicalize` implementations: scorer uses default-locale `localeCompare` (`canonical-json.ts:12-13`, also `score-suite.ts:34`, `load.ts:490`); the two in the leaderboard use code-unit `sort()`. The orders differ for the current key set, but the hashes were stable across the 7 locales I tried | Latent cross-machine hash divergence, and anyone re-implementing `corpus_hash` needs ICU collation | One shared code-unit-order canonicaliser (RFC 8785 style) | observed in code; divergence not reproduced |
| L8 | low | Driver and guardrail share a uid | Documented at `driver/main.ts:48-55`. `GdpClient.close` signals only the `sh` wrapper (`gdp.ts:268-297`), so "the guardrail can no longer observe the write" is not guaranteed for compound commands | A hostile guardrail in a ranked run can read the driver's task file and record directory | Separate uids for driver and guardrail in the ranked image, kill the process group | observed in code |
| L9 | low | Maintainability | 36% of non-blank source lines are comments (3,608 of 10,079 code lines), and 199 of them cite a review round ("code review finding 3", "security re-review N2"). `X402_STARTUP_TIMEOUT_S` is read by the driver but never set (`driver/main.ts:100-110`) | Review history lives in code comments instead of commits or PRs, and will age badly. One piece of dead wiring | Move rationale to ADRs or commit messages, keep comments about the code as it is | observed in code |
| L10 | low | Scoring | `score-run.ts` never compares a payment's `from` with the agent's wallet. Raised as m3 in the project's own Architecture Review 1 and still open | A payment signed by another key is scored as the agent's | Flag foreign payers | observed in code |
| L11 | low | Repo hygiene | No `SECURITY.md`, changelog, Dependabot or Renovate config, coverage measurement, or code scanning of the repo itself. `@types/node` uses a caret range and the root `tsx` is `^4.19.2` against `4.23.15` elsewhere, contrary to the "pin exactly" rule (`CLAUDE.md:39`). `results/internal/sdk-default-baseline.json` is tracked although the audit log calls it internal-only. Corpus files are split between the root and per-category folders | Expected basics for a public security tool are missing | Add them before launch | observed in code |

---

## 5. Proof of work

### 5.1 What the repository quantifiably shows

| Measure | Value | How obtained |
|---|---|---|
| Commits | 122 on `main`, 26 merges, between 2026-09-30 and 2026-10-04, with commits on 4 of those 5 days | `git rev-list --count`, `git log --date` |
| Authorship | One git author for all 122. 100 commits carry an AI co-author trailer (81, 17 and 2 across three models) | `git log --format='%an'`, trailer count |
| Commit types | 55 docs, 25 feat, 26 merge, 9 fix, 3 chore, 2 test, 1 refactor, 1 build | subject prefixes |
| Source | 14,756 lines of TypeScript in 91 files (about 10,100 code, 3,600 comment) plus 176 lines of Python | `git ls-files` + `wc` |
| Tests | 15,566 lines in 84 files. 848 executed unit cases. 6 e2e files | same, plus vitest output |
| Test-to-source ratio | 1.05 by line overall. By package: adversary 1.23, capture 1.13, cli 1.76, driver 0.43, leaderboard 1.06, schema 1.04, scorer 1.45 | per-package counts |
| Tests travel with code | 30 of 34 non-merge commits that touch source also touch tests (88%). 7 of 9 `fix` commits include a test change | script over `git show --name-only` |
| Design before code | 22 per-unit functional design documents, 16 ADRs, requirements, application design, units of work: 2,859 lines under `aidlc-docs/` | file counts |
| Gates | 6 recorded owner approvals (G0, G1, G2, G3, G5, G6); G7 pending | `aidlc-docs/audit.md` |
| Review rounds | About 20 recorded review events, 12 with an explicit verdict: 7 blocking ("do not merge", "BLOCK") and 5 "merge after fixes" | `grep` over `audit.md` |
| Independent reviews on file | Architecture Review 1 (4 blockers, 7 majors, 5 minors) and a Bolt 5 close-out (5 new issues) | `aidlc-docs/reviews/` |
| Corpus | 52 scenarios: 48 attacks in 16 categories of 3, plus 4 controls. 101 runs per suite | `validate`, report output |

### 5.2 Reviews that changed the product, which I could confirm in the code

- **A crashing agent used to score 100%.** Architecture Review 1 reproduced `--agent "true"` and `--agent "exit 3"` exiting 0 with a perfect score. Today both exit 2 with an INVALID banner; I ran it. The fix is at `score-run.ts:200,326-332` and `score-suite.ts:172-174`.
- **A submitter could delete a violation undetected.** The close-out review found the leaderboard stripped one violation type from both sides of its re-score comparison. The special case is gone and a deterministic flag is persisted instead (`score-suite.ts:304-321`, `build-leaderboard.ts:205-208`).
- **Only the first transfer leg of a transaction was captured.** A code review found a run could pay the attacker and the provider in one transaction and pass. Every leg is now recorded (`packages/capture/src/evm.ts:583-644`, `packages/adversary/src/record.ts:183-191`).
- **A malformed guardrail reply failed open.** `"DENY"` was not `"deny"`, and a transfer went out. The decision check is now exact-match, default deny (`gdp.ts:182-188`).
- **A reference agent could be steered to real DNS.** An unanchored `.localhost` match was replaced by exact origin membership (`driver/src/crawl.ts:95-112`).
- **Action inputs were interpolated into shell.** Now zero expressions in any `run:` block, enforced by a test.
- **Calibration caught a real driver bug.** The reference policy failed one scenario because the driver dropped a referrer; the fix is `packages/driver/src/source-map.ts`, and my reference-policy run passes that scenario.

The log also records things that reflect less well and were written down anyway: an agent installing a tool outside its remit, a reviewer stalling and the orchestrator self-reviewing instead, an LLM budget that was per process rather than per session, a corpus author reading files it was told not to, CI being red on `main` for a period, and a deliberate edit to an append-only log. That candour is itself evidence of discipline.

### 5.3 What this evidence does not prove

- **No human code review is visible.** The developer, the reviewers and the architect were AI roles (`.claude/agents/`), coordinated by an AI orchestrator. The human contribution on record is six gate approvals and a set of decisions. The quality of the result is checkable; the independence of the reviewers from the author is weaker than it would be between people.
- **The audit log is self-reported.** `audit.md` was written by the orchestrator about its own work. Commits corroborate that units landed and merged in the stated order, but each unit arrives as one large commit (mean 485 lines, largest 4,758 excluding generated results), so individual review findings and their fixes are not separable in history. They are traceable only through the log and through code comments.
- **CI has never run.** There is no remote. Every "CI" claim is a local run. The five workflows are unexecuted.
- **The published history will not be this history.** By the repo's own rule the public repo starts from an orphan commit, so an outside reader will not be able to check any commit-level figure in 5.1.
- **Validity beyond the reference agents is untested.** No real LLM agent run, no third-party guardrail and no external user is recorded. All four reference entries were written by the same hands as the corpus.
- **Coverage is unmeasured.** Test volume is high, but no coverage tool is configured, so I cannot say what fraction of branches the 848 tests reach.
- **Speed is not a quality signal.** About 30,000 lines in five days is evidence of throughput, not of soak time. Nothing here has been used in anger.

---

## 6. Pre-release checklist

Ranked. Items 1 to 6 should block a public launch.

1. **Decide the publication plan for history and process evidence** (H4). Remove the personal detail at `aidlc-docs/audit.md:77`. Choose between an orphan commit and a scrubbed rewrite, and decide what stands in for commit-level proof.
2. **Make harness identity work** (H2). Inject the commit into the container and the Action, refuse `"unknown"` for tiered entries, add a test that a containerised run produces an allowlistable report.
3. **Pin the supply chain** (H3). All 27 action references and the base image by digest, the real `AGE_SHA256`, an update bot for actions.
4. **Execute the provenance pipeline once, for real** (H1, M3, M4). Create the org, replace both placeholders and CODEOWNERS, dry-run `rank.yml` and `ranked-run.yml` with a non-trivial guardrail, bind the attested file to the run job by digest, and commit the run links as evidence.
5. **Fix the two integrity defects in the runner** (M1, M2). Unknown scenario ids and zero selected attacks must exit 2. Kill the agent's process group after every run and reject stale requests.
6. **Move off Node 20** (M5). CI, Action and image to a supported LTS, with a version matrix.
7. **Bring the docs back in line** (M6). README quickstart output and category count, `action.yml` `redact`, CONTRIBUTING's tag example, `CLAUDE.md` layout, `aidlc-state.md`. Add a diff-check so the README sample cannot drift again.
8. **Settle distribution** (M7). Publish built packages with a real version, or state that the Action and a clone are the only supported routes.
9. **Close the validation gaps** (M8). Run the Python test in CI. Record one real LLM-agent run and one external guardrail.
10. **Validate CLI options** (L1) and round aggregate sums (L6).
11. **Add the public-repo basics** (L11): `SECURITY.md`, changelog, coverage, workflow linting, update bot.
12. **Tidy** (L3, L4, L7, L8, L9, L10) as time allows.

---

## 7. Method and limits

**What I did.** Read the root config, all five workflows, the Action, the Dockerfile and entrypoint, and all of `cli`, `scorer`, `driver`'s main, protocol client, payment and crawl modules, `leaderboard`, the schema loader, the adversary's server, routes, proxy, facilitator and recording modules, the EVM decoder, attribution and merge. Read the README, CONTRIBUTING, CLAUDE.md, the requirements, the audit log in full, Architecture Review 1, the Bolt 5 close-out and ADR-011. Ran install, lint, typecheck, unit tests on two Node versions, a build of every package, the dependency audit, ten full or partial CLI suites, three e2e files and about fifteen targeted probes. Computed all process figures from git.

**What I did not or could not do.**

- **Not executed: any GitHub workflow, the Docker image, `age` decryption, `gh attestation verify`.** No docker and no GitHub API by instruction. Findings H1, M3 and M4 rest on reading. M4 in particular depends on runner behaviour I could not test.
- **Not executed: the `--agent-uid` privilege drop.** It needs Linux and root.
- **Not run: `run-suite`, `corpus-v2` and `driver-calibration` e2e files.** Their main assertions were reproduced through the CLI instead.
- **Not run: the Python agent** (no local venv) **or the LLM agent** (needs an API key and network).
- **Not verified: `*.localhost` resolution on Linux runners, musl or Windows.** Only macOS here.
- **Read in part only:** the Solana decoder (first 140 of 652 lines), the mock EVM and Solana RPC modules, the scenario schema, template rendering, the example agents other than the LLM tools, and the markdown and SARIF reporters. I did not review the 52 scenario files for oracle soundness one by one.
- **Not inspected: the held-out corpus** (out of scope) **and the content of historical commits that the repo says contain held-out detail.** I confirmed only that the repo's own documents make that statement.
- **Not checked online:** current support status of the action major versions in use.
- **One self-inflicted false alarm, corrected:** my first reference-policy comparison differed from the committed result only because I passed a different `--agent-id`. With that label normalised the reports are identical.
