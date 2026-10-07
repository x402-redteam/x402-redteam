# Units of Work and Bolt Plan

Roles: **Opus** is the orchestrator, architect and reviewer. **Sonnet** is the lead developer, running as Agent-tool subagents with `model: sonnet`, one unit per agent, in an isolated git worktree whenever units run in parallel.

## Units
| Unit | Package | Scope | Acceptance (DoD) |
|---|---|---|---|
| U1 | workspace + `packages/schema` | pnpm workspace, tsconfig base, biome, vitest, `ci.yml` (lint + test); zod schemas and types from application-design §3–4; YAML loader; templating; canaries; chain defaults; USD↔atomic | `pnpm -r test` is green; the loader rejects bad YAML with a path-qualified error; canaries are stable across runs (snapshot) |
| U2 | `packages/adversary` | Hono server per §5: routes, virtual hosts, 402 issuer, behaviours, mock facilitator, mock Solana RPC, ledger endpoint, `createAdversary` API | Integration tests using the **real** `@x402/fetch` + `@x402/evm` + `@x402/svm` clients pay against it offline and produce the expected ledger for each behaviour |
| U3 | `packages/capture` | EVM decoder (EIP-3009 typed data → from/to/value, signature recovery), SVM decoder (tx → TransferChecked dest owner/amount/mint, signer), attribution + merge (§4), signer shim `wrapEvmAccount`, `wrapSvmSigner`, `recordTransfer` | Decoders are tested on fixtures signed by viem / @solana/kit; attribution has a table test covering header, prose, none and replay |
| U4 | `packages/scorer` | `scoreRun`, `scoreSuite`, JSON / SARIF / markdown reporters (§7) | Table tests per violation code; the SARIF output validates against the 2.1.0 JSON schema; the JSON is deterministic (snapshot) |
| U5 | `packages/cli` + `examples/agents` | Runner (§6), task file, spawn, timeout, `--repeat`, `validate` and `report` commands; the naive and guarded reference agents (§8) | E2E: naive fails every scenario and guarded passes every scenario; two runs give identical report.json without `timing`; the full run takes under 5 min |
| U6 | `corpus/` | 10 scenarios (one per category), each on both chains, plus `corpus/README.md` documenting the schema | `x402-redteam validate` passes; each scenario has a one-paragraph rationale naming the documented attack it models |
| U7 | `action/`, README, leaderboard | Composite GitHub Action (install, run, upload-sarif), top-level README with a quickstart, `leaderboard/` generator (reads `results/*.json` and writes `LEADERBOARD.md`) | Action YAML lints; leaderboard renders from the two reference-agent results |
| U8 | `packages/chain-local` (stretch) | Mode B: anvil + solana-test-validator bootstrap, mock USDC deploy, on-chain settle | Cut if Bolt 3 slips. Neither tool is installed locally |

## Dependencies
```
U1 ─┬─► U2 ─┐
    ├─► U3 ─┼─► U5 ─► U7 ─► (U8)
    └─► U4 ─┘    ▲
    U1 ─► U6 ────┘
```
U2 depends on U3 at runtime (decoders). To keep Bolt 2 parallel, U2 codes against the `capture` interface declared in U1 (`packages/schema/src/capture-api.ts`, types only) and uses a stub until merge. Opus does the integration at Gate G2.

## Bolts and gates
| Bolt | Units | Mode | Gate |
|---|---|---|---|
| Inception | — | Opus | **G0**: approve requirements, design and this plan |
| Bolt 1 | U1 | 1 Sonnet agent, main tree | **G1** |
| Bolt 2 | U2, U3, U4 | 3 Sonnet agents in parallel worktrees → Opus merges and integrates | **G2** |
| Bolt 3 | U5, U6 | 2 Sonnet agents in parallel worktrees → Opus runs E2E | **G3** |
| Bolt 4 | U7 (+U8) | 1–2 Sonnet agents | **G4**: MVP done |

## Per-unit loop
1. Opus writes `aidlc-docs/construction/<unit>/functional-design.md`, covering the interfaces, file list, acceptance tests and "do not" list.
2. A Sonnet agent implements the unit test-first and runs `pnpm -F <pkg> test` and lint, then reports its deviations.
3. Opus reviews the diff against the design, runs the tests, merges, and appends to `audit.md`.
4. Findings go back to the same Sonnet agent through SendMessage and are fixed before the gate.

---

## Bolt 5 — Measurement validity (from Architecture Review 1, accepted at G5)

| Unit | Scope | Design |
|---|---|---|
| U9 | **Part A:** schema v2 contract landing. **Part B:** controls, run validity, exposure cap, safety score, CLI exit v2 | `construction/U9-validity/` |
| U10 | Mock EVM RPC; Solana `sendTransaction` capture; naive switches to real RPC transfers | `construction/U10-chain-capture/` |
| U11 | Corpus v2: oracle fixes, no-hint prompts, variants, 6 new attack classes, guarded fix *after* recording its failures | `construction/U11-corpus-v2/` |
| U12 | TS LLM agent (skipped without a key) and a Python x402 agent; integration docs; `action.yml` | `construction/U12-real-agents/` |
| U13 | Leaderboard acceptance checks, re-scoring, ranking v2, sdk-default baseline, honest CONTRIBUTING | `construction/U13-leaderboard-hygiene/` |

### Dependencies and parallelism
```
Phase A (sequential, main tree or 1 worktree):  U9-A schema v2 ──► merge + full checks
Phase B (3 parallel worktrees):                 U9-B   U10   U11   ──► merge in the order U9-B, U10, U11; integrate
Phase C (2 parallel worktrees):                 U12    U13          ──► merge U12, then U13 (regenerates results last)
Gate G6 after Phase C.
```
- **Why Part A first:** `schema/scenario.ts`, `ledger.ts`, `chains.ts`, `load.ts`, `cli/task.ts` and the env block in `cli/run.ts` would otherwise be edited by three units at once. Part A lands every contract field (defaults and types only), so Phase B units consume them without touching those files.
- **Merge order in Phase B:**
  - U9-B changes the report shape and the E2E expectations.
  - U10 changes naive's prose path.
  - U11 changes the corpus and guarded, and needs U10's `solana-rpc.ts` `assetInfo` mint decimals for `asset-swap` on svm.
  - Expect the orchestrator to fix up the E2E test expectations after the U11 merge; U11's `corpus-v2.e2e.test.ts` is authoritative for corpus-level counts.
- **Cross-unit features verified only at integration:**
  - `authorization-lifetime`: U10 capture fills `authorization_seconds`, U9 scores it, U11 supplies the scenario.
  - `asset-swap` on svm: U10's mint decimals and U11's scenario.
- **The CI leaderboard diff-check** will be red from the U9-B merge until U13 regenerates `results/`. That's expected; don't hand-patch it in between.
- **Lockfile:** only U12 adds dependencies (`@anthropic-ai/sdk`). The Python lock is separate (`examples/agents-py/uv.lock`).

### File ownership (Bolt 5; one owner per file; others must request changes via the orchestrator)
| Path | Owner |
|---|---|
| `packages/schema/src/**`, `cli/src/task.ts`, the env block in `cli/src/run.ts` | U9-A |
| `packages/schema/test/corpus.test.ts` | U9-A, then U11 |
| `packages/scorer/**`, `cli/src/{run,main}.ts` (rest), `cli/test/{run-suite.e2e,exit-code}.test.ts`, `corpus/controls/**` | U9-B |
| `adversary/src/{record,evm-rpc,solana-rpc,ledger-endpoint,facilitator,state,index}.ts`, `capture/src/{evm,svm,merge}.ts`, `examples/agents/src/{naive.ts,lib/**}` | U10 |
| `adversary/src/{challenge,routes,render}.ts`, `capture/src/attribute.ts`, `corpus/**` (except controls), `corpus/README.md`, `examples/agents/src/guarded.ts` | U11 |
| `examples/agents/src/llm.ts`, `examples/agents/scripts/**`, `examples/agents/package.json`, `examples/agents-py/**`, `action.yml`, README "Integration contract" section | U12 |
| `packages/leaderboard/**`, `results/**`, `LEADERBOARD.md`, `CONTRIBUTING.md`, `examples/agents/src/sdk-default.ts`, README quickstart and "Leaderboard" sections | U13 |

> Orchestrator decision (U9-A fixes): `packages/cli/test/corpus-hash.test.ts` pins the corpus hash; owned by **U11**, which updates the pinned value deliberately when corpus v2 lands.

> Orchestrator decision (U9-A review, M3): `adversary/src/facilitator.ts` assigned to **U10**. It must iterate `challenge.accepts` in `/supported` and use `amountUsd(..., scenario.assets)` + `asset_known` on `/verify` like `ledger-endpoint.ts`.

### Bolt 6: see the "Bolt 6" section below (designed 2026-10-01)

---

## Bolt 6 — Before public launch (ranked guardrail track, provenance, realistic hosts, rail port)
Design: senior-architect, 2026-10-01. Evidence: `reviews/bolt5-closeout.md`. ADRs: 010/011/012/014 (full) and 016. Contracts: application-design "(v3, Bolt 6)". Gate **G7** after Phase C. Public launch is a separate user gate, **G8**.

| Unit | Scope (one line) | Design |
|---|---|---|
| U15 | Contract v3 landing: reach_class/surface/rail, hosts.ts, report@3 config fingerprint, CLI flags with stubs, corpus tagging | `construction/U15-contract-v3/` |
| U16 | Scorer and leaderboard v3: `reached` and per-class rates, persisted authorization flag (N1), canonical v3, two-track tables, Wilson CI | `construction/U16-scoring-leaderboard-v3/` |
| U17 | Realistic hosts: Host-header routing on `*.localhost`, preflight fallback, forward proxy, reference agents on hostnames, M1 validity probe | `construction/U17-realistic-hosts/` |
| U18 | Guardrail-track standard driver `driver@1` plus GDP v1 (stdio), example guardrails, calibration E2E | `construction/U18-guardrail-driver/` |
| U19 | Provenance tiers, seasons (secret seed, commitment), redaction, agent uid, rank.yml and ranked-run.yml, results and LEADERBOARD regeneration | `construction/U19-provenance-seasons/` |
| U20 | Rail port: x402v2 behind `Rail`, MPP-shaped fake-rail test, challenge_mismatch | `construction/U20-rail-port/` |
| U21 | Capture lows: SetAuthority valued at modelled balance; plain SPL Transfer asset via known token accounts | `construction/U21-capture-lows/` |
| U22 | Action v3 inputs and outputs, exact-exit self-test matrix, host-resolution CI job, real-runner checklist | `construction/U22-action-launch-ci/` |
| U23 | Public corpus v3 (≥ 3 variants per category) plus Season 1 held-out corpus written outside the repo by separate authors | `construction/U23-corpus-v3-season1/` |

### Phases and parallelism
```
Phase A (serial):     U15 ──► merge + orchestrator E2E (path mode, byte-compare naive/guarded minus schema/config)
Phase B1 (3 worktrees): U16   U17   U18          merge order U17 → U18 → U16
Phase B2 (2 worktrees): U20   U21                (start when B1 reaches code review; merge U21 → U20; U20 needs a byte-identical report check)
Phase C (3 agents):   U19   U22   U23-public  (+ U23-heldout outside the repo)
                      merge U23-public → U22 → U19 (U19 regenerates results LAST)
Orchestrator:         driver calibration E2E, full test:e2e, held-out calibration, then the real-runner checklist (needs user G7 decisions)
Gate G7 (Bolt 6 done) → G8 (public launch: user decides publishing)
```
- **No more than 3 concurrent developer agents.** The machine's load average is 5–17, and Bolt 5 lost agents to stalls from long commands.
- **Command budget:** every developer command must finish in under 3 minutes. Use `pnpm test` (≈ 10 s), `pnpm -F <pkg> test`, and CLI probes with `--scenario <id>` (≈ 1 min each).
  - Developers **never** run `pnpm test:e2e`, the calibration E2E, or full-corpus CLI runs. Each design lists the "Orchestrator only" checks.
  - The orchestrator runs E2E one suite at a time, in the background, using the Monitor tool, never with a blocking command over 600 s.
- **Merge order rationale:**
  - U17 changes `task.allowed_hosts` semantics and the reference agents, so it goes first in B1.
  - U18's driver must work in localhost mode.
  - U16 merges last in B1 because its canonical check (`host_mode=localhost`, `driver@1`) presumes both.
  - U20 must be byte-identical, so it is checked on a quiet tree after U21.
- **The CI leaderboard diff** may go red from the U15 merge (report@3) until U19 regenerates. That's expected; don't hand-patch.
- **Lockfile:** U18 adds the workspace package `packages/driver` (no external dependencies). No other unit adds dependencies. `mppx` and `age` are user decisions.

### File ownership (Bolt 6; one owner per file per phase; "A → B" means ownership passes after A merges)
| Path | Owner |
|---|---|
| `packages/schema/src/**` | U15 |
| `packages/scorer/src/types.ts`, `resolve.ts` | U15 → U16 |
| `packages/scorer/src/{score-run,score-suite,reach,wilson,markdown-reporter,sarif-reporter}.ts` | U15 (score-suite config pass-through only) → U16 |
| `packages/scorer/src/redact.ts` | U19 |
| `packages/leaderboard/**` | U16 → U19 |
| `packages/cli/src/{main,run,task}.ts` | U15. Then: `main.ts` default flip → U17. `run.ts` `--redact` line → U19 |
| `packages/cli/src/host-env.ts` | U15 (stub) → U17 |
| `packages/cli/src/guardrail-track.ts` | U15 (stub) → U18 |
| `packages/cli/src/season.ts`, `spawn.ts` | U15 (stub, season only) → U19 |
| `packages/cli/test/corpus-v2.e2e.test.ts`, `corpus-hash.test.ts` | U15 → U23-public |
| `packages/cli/test/hosts.e2e.test.ts` | U17 |
| `packages/cli/test/driver-calibration.e2e.test.ts` | U18 |
| `packages/adversary/src/hosts.ts`, `proxy.ts`, `index.ts` | U15 (extract) → U17 |
| `packages/adversary/src/{routes,challenge,render}.ts`, `rails/**` | U15 (routes.ts call-site, render.ts host()) → U20 |
| `packages/adversary/src/{record,facilitator,evm-rpc,solana-rpc,state}.ts` | U21 (record.ts only; the others are unowned, so request via the orchestrator) |
| `packages/capture/src/svm.ts` | U21 |
| `packages/driver/**`, `examples/guardrails/**` | U18 |
| `examples/agents/**`, `examples/agents-py/**` | U17 |
| `corpus/**` (YAML tags), `corpus/decoy-domains.txt` | U15 → U23-public |
| `action.yml`, `.github/workflows/{self-test,ci}.yml` | U22 |
| `.github/workflows/{rank,ranked-run}.yml`, `.github/ranked/**`, `docs/seasons.md` | U19 |
| `results/**`, `LEADERBOARD.md`, `CONTRIBUTING.md` | U19 |
| README: "Integration contract" (host modes) / "Action" / "Leaderboard" | U17 / U22 / U19 |
| `$X402_HELDOUT_DIR/**` (outside the repo) | U23-heldout |

### Decisions only the user can make (needed at G7; the U22 checklist and U19/U23 Tier 1 work are blocked on items 1–3)
1. **GitHub org/repo:** the name, creating the public repo, the first push, and branch protection. Also create a private repo for held-out corpora and a `ranked` environment with maintainer-only reviewers.
2. **Secrets:**
   - who generates and holds the Season 1 seed and the age key (Actions secrets plus an offline backup);
   - the season length (proposed: quarterly);
   - the reveal policy (proposed: publish the seed and corpus at season end).
3. **Held-out authorship:** who writes Season 1. The proposal is separate Sonnet agents that never saw the reference policies, or an external contributor. A human spot-check is recommended.
4. **Publishing (G8):**
   - when LEADERBOARD.md is first published as "ranked";
   - whether the `sdk-defaults` row (the Coinbase SDK baseline, today `results/internal/`) is public;
   - whether Tier 3 (self-reported) is shown or rejected (default rejected).
5. **Coinbase relationship:**
   - whether to give Coinbase advance notice of the SDK findings (`registerExactSvmScheme` drops `rpcUrl`; the $1 cap and asset allowlist), and how long before launch;
   - whether to invite x402 maintainers to review the corpus;
   - trademark use of "x402" in the project name.
6. **Cost:**
   - agent-track LLM runs at `repeat 5` cost up to ≈ $75 per agent per full corpus at the $0.25-per-run cap. The G5 budget ($5 per session) does not cover this;
   - other providers' API keys if non-Claude agents are to be observed;
   - Actions minutes are free for public repos. Private-repo attestations reportedly need GitHub Enterprise Cloud (unverified), which is why ranked-run is public.
7. **ADR-012:** whether to buy or own decoy domains for realistic proxy-mode hostnames. The default is reserved TLDs only.
8. **MPP (Bolt 7):**
   - adding `mppx`, which method first (evm or solana charge vs Tempo, a third chain), and whether to contact Stripe/Tempo;
   - the EVM-charge credential shape is unverified.
9. **Ranking policy:**
   - open-source requirement for Tier 1;
   - whether entries implementing only the `sign` hook rank alongside full-hook entries (proposed: same table, with a hooks column);
   - the policy forbidding environment detection.
10. **Audit offering:**
    - the deliverable (private report plus ledger review), pricing, the liability disclaimer and terms;
    - whether audited closed-source guardrails may display an "audited" badge (proposed: no leaderboard rank).

## Bolt 7 — Release engineering and open-source operations (designed 2026-10-07, senior-architect; Proposed, gate G8)

ADRs: ADR-017 to ADR-027 (`adr/decisions.md`). Unit designs: `construction/U24-*/`.

**Renumbering note:** earlier docs point MPP, push-mode and session rails, and the driver authority-grant intent at "Bolt 7" (ADR-014 §5, audit 2026-10-04). Those move to **Bolt 8**. Owner to confirm (D11).

### Recommended shape
- **There is no server.** Deployment means four things, each behind an environment (ADR-024): an immutable GitHub Release, a GHCR ranked image pulled by digest, a leaderboard merge, and optional Pages.
- **One repo-wide version**, starting at v0.1.0.
- **Releases are cut by a merged "chore(release)" PR plus a `release` environment approval**, and carry an SBOM and Sigstore attestation bundles.
- **No npm at launch.**
- **History:** a verified `filter-repo` rewrite instead of the orphan commit.
- **CI:** one required check, `ci-ok`, with path-gated E2E on PRs and a nightly matrix.
- **Supply chain:** Dependabot with a cooldown over SHA pins on current Node-24-runtime majors, plus CodeQL, zizmor, actionlint and Scorecard.
- **Honesty about solo operation and AI review in GOVERNANCE.md** is the credibility move. Scorecard can't be maxed solo, and we won't game it.

### Challenges to the current repo and to the framing
1. **The H3/M5 fixes are partial.**
   - The 27 pins are genuine SHAs (5 of 8 distinct actions checked against upstream tags; all 5 match), but they pin superseded majors. `checkout@v4.4.0` runs on `node20`, which GitHub removes from runners this autumn.
   - `verify-results.yml` still sets Node 20.
   - Node 22 has about 6 months of support left.
   - Commits ea5ce93, 9250098 and c878966 have **no audit.md entry**, a process breach.
2. **"The Action vendors its own deps" is false.** It runs `pnpm install` from the registry, dev dependencies included, on every consumer run.
3. **"3 commits" understates the history exposure.** The sensitive lines are present in the snapshots of up to 82 commits. A rewrite is still cheap because nothing has been pushed.
4. **Changesets doesn't fit, and npm publishing isn't needed now.** Pages is premature.
5. **The real professionalism gap is people, not badges.**
   - One person holds the season seed, dispatches ranked runs and approves them.
   - CODEOWNERS and environment self-review protections are unenforceable solo.
   - Scorecard Code-Review and Contributors stay at 0, and Best Practices Gold is unreachable.
   - A second human maintainer is worth more than any workflow.
6. **E2E on PRs is affordable** (public repo minutes; verify at org creation). Gate on paths, not on schedule.

### Units
| Unit | Scope (one line) | Executor | Phase |
|---|---|---|---|
| U24-A | SECURITY, CoC 3.0, GOVERNANCE (AI-review disclosure), SUPPORT, issue/PR templates, CODEOWNERS default, `pr-hygiene.yml` (Conventional title plus DCO), held-out leak guard (local hook plus HMAC CI) | Sonnet | 0b |
| U24-B | Node 24 primary / 22.14 floor, exact `@types/node` and `tsx`, `minimumReleaseAge`, ranked base digest, one code-unit canonicaliser (L7) | Sonnet | 0a (first, alone) |
| U24-C | `ci.yml` rewrite (changes → fast / e2e / self-test → `ci-ok`), self-test as `workflow_call`, `nightly.yml` (Node 22/24/26, macOS, Python, audit, ranked dry run), coverage thresholds | Sonnet | 0b |
| U24-D | Pin bump to current majors, `actions/attest`, Dependabot (cooldown), CodeQL, Scorecard, zizmor plus actionlint, `pins.test.ts` | Sonnet | 0b |
| U24-E | Single version source, `harness_version` from package.json, changelog generator, `release:prepare`, `release.yml` (draft → immutable publish, SBOM, attestations, major tag), Action `--prod` install plus branding, README install/verify/badges, RELEASING.md | Sonnet | 0c |
| U24-F | `release-image.yml` (GHCR, BuildKit SBOM/provenance, attest by digest), rank/ranked-run pull-and-verify by digest, `_harness.json` object form | Sonnet | 0c |
| U24-G | (conditional on D5) bundled `x402-redteam` npm package with trusted publishing | Sonnet | 3 |
| U24-H | Denylist, `filter-repo` rewrite plus verification, placeholders, first push, repo settings, rulesets, environments, Phase 2 evidence | **Orchestrator only** | 1 → 2 |

At most 3 Sonnet agents run concurrently (0b: A, C, D; 0c: E, F). Developer commands are all under 3 min (`pnpm lint/typecheck/test`, `test:coverage` under 2 min). **Orchestrator-only:**
- E2E and reference-result regeneration (U24-B, U24-E);
- verifying the SHAs and the base-image digest;
- the denylist and HMAC list;
- anything with GitHub settings, pushing, tags or releases;
- the first runs of CodeQL, zizmor and Scorecard.

### Phase plan
- **Phase 0 (no org needed):** 0a U24-B → 0b U24-A, U24-C, U24-D (merge C before D: shared `action-yaml.test.ts`) → 0c U24-E, U24-F. Everything is static; no workflow executes.
- **Phase 1 (org name decided, empty repo created, nothing pushed):** U24-H §0–5: edit CLAUDE.md, denylist, pre-scan, rewrite, verify, substitute placeholders.
- **Phase 2 (after the owner's push go-ahead):** U24-H §6–8: push; settings, rulesets and environments; first CI, nightly and Scorecard; U22 real-runner checklist; rank.yml dry run; `v0.1.0` release plus image; Best Practices "passing". Gate **G8**.
- **Phase 3 (post-launch):** U24-G if D5; Pages if D9; Silver badge once there is a second maintainer and coverage is at least 80 %; Bolt 8 (MPP etc.).

### File ownership (Bolt 7; one owner per file per phase; "A → B" = passes after A merges)
| Path | Owner |
|---|---|
| `package.json` | U24-B (engines, devDeps) → U24-A (`prepare-hooks` script) and U24-C (`test:coverage`), with the lines merged by the orchestrator → U24-E (version, release scripts) |
| `packages/*/package.json`, `examples/*/package.json` | U24-B (`@types/node`) → U24-E (`version`) → U24-G (cli only) |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.node-version` | U24-B → U24-C (coverage dependency only) |
| `packages/schema/src/canonical.ts`, all `localeCompare` call sites | U24-B |
| `packages/cli/src/run.ts` (line 564), `packages/cli/src/version.ts` | U24-E |
| `packages/leaderboard/**` (harness allowlist reader) | U24-B (canonicaliser) → U24-F |
| `action.yml` | U24-B (`node-version`) → U24-D (pins) → U24-E (install, branding) |
| `.github/workflows/ci.yml`, `self-test.yml`, `nightly.yml`, `vitest.config.ts` (coverage) | U24-B (`node-version`) → U24-C. The `workflow_call` line for release goes to the orchestrator |
| `.github/workflows/{codeql,scorecard,zizmor}.yml`, `.github/dependabot.yml`, `.github/zizmor.yml`, `packages/cli/test/pins.test.ts` | U24-D |
| `.github/workflows/{rank,ranked-run}.yml`, `.github/ranked/**`, `release-image.yml`, `results/_harness.json`, `docs/seasons.md` | U24-B (Dockerfile FROM) → U24-D (pins) → U24-F |
| `.github/workflows/verify-results.yml` | U24-B (node) → U24-D (pins) |
| `.github/workflows/release.yml`, `scripts/release/**`, `CHANGELOG.md`, `docs/RELEASING.md` | U24-E |
| `.github/workflows/{pr-hygiene,heldout-guard}.yml`, `scripts/{pr-hygiene,heldout-guard,heldout-guard-ci}.mjs`, `.githooks/**`, `.github/heldout-guard.hmac` (empty) | U24-A (the HMAC contents come from the orchestrator in U24-H) |
| `scripts/ci-changes.mjs` | U24-C |
| `scripts/ranked/**` | U24-F |
| `SECURITY.md`, `CODE_OF_CONDUCT.md`, `GOVERNANCE.md`, `SUPPORT.md`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS` | U24-A → U24-H (placeholders) |
| `CONTRIBUTING.md` | U24-A ("Development workflow" section) and U24-E (leaderboard tag examples): separate sections, merged sequentially |
| `README.md` | U24-E (badges, Install, Verify a release, Versioning) |
| `packages/cli/test/action-yaml.test.ts` | U24-C → U24-D (pin assertions only) |
| `packages/cli/test/ranked-workflows.test.ts` | U24-D (pin assertions) → U24-F |
| `CLAUDE.md`, `aidlc-docs/**`, `results/*.json`, `LEADERBOARD.md` | orchestrator |

### Decisions only the owner can make (needed at G8; items 1–4 block Phase 1/2)
1. **D1 Org and repo name:** create them and give the push go-ahead. "x402" trademark use is still open from the G7 list.
2. **D2 History:** approve the ADR-025 rewrite (recommended) or keep the orphan-commit rule. Archive or destroy the original local repo afterwards.
3. **D3 Public contacts:** the security and CoC contact address (a role address, not a personal inbox), the SUPPORT and commercial-audit contact, and whether to use Discussions.
4. **D4 People:** recruit a second maintainer or reviewer before Season 1 is ranked (recommended). Until then, accept and publicly disclose solo self-approval of `ranked` and `release`. Name a successor with org-owner access (Best Practices `access_continuity`; Silver blocker).
5. **D5 npm:** none at launch (recommended), or option B post-launch (U24-G). Whether to hold the name with a real 0.x.
6. **D6 Release identity:** a GitHub App for tags and the major-tag move (vitest pattern; recommended if ruleset bypass for `GITHUB_TOKEN` proves impossible) vs `GITHUB_TOKEN`.
7. **D7 Image:** a public GHCR image (recommended), or private, which breaks outsider verification.
8. **D8 Version:** `v0.1.0` first (recommended) vs `v1.0.0`. What triggers 1.0.
9. **D9 Coverage badge and Pages:** Codecov (third party, OIDC) vs self-hosted coverage JSON; Pages now (not recommended) or later; a custom domain.
10. **D10 Tools:** allow `uvx git-filter-repo==2.47.0` (and optionally `uvx zizmor`) locally. Both are ephemeral, with no global install, but CLAUDE.md requires asking.
11. **D11 Naming:** the old Bolt 7 scope (MPP, push-mode, session rails, authority-grant intent) moves to Bolt 8.
12. **D12 Signing:** set up an SSH signing key for maintainer commits, and whether to require signed commits in the ruleset (recommended, with squash-only).
13. **D13 Best Practices:** the owner's account submits the self-assessment, and the owner affirms the answers.
