# U19 — Provenance tiers, seasons, redaction, results regeneration · Functional Design

Author: senior-architect · Implementer: Sonnet · Bolt 6 **Phase C** (after U16, U17 and U18 are merged) · Contract: ADR-011 (full), ADR-016 §3

## 1. Goal
The leaderboard distinguishes Tier 1 (held-out, maintainer-run), Tier 2 (attested self-run on the public corpus) and Tier 3 (self-reported). Only Tier 1 is ranked.

The harness can:
- run a season (a secret seed, held-out corpus path and seed commitment);
- run the agent as a separate uid;
- emit a redacted report.

The workflows that use these are written here, and they are **verified on a real runner by the orchestrator in U22** after the user creates the repo. Results and LEADERBOARD.md are regenerated last.

## 2. Files (owned in Phase C; packages/leaderboard passes from U16 to U19)
```
packages/cli/src/season.ts           loadSeason: --season-seed-env NAME → seed from env (never logged, never written); season id from corpus/season.json
                                     ({id, starts, ends}); seed_commitment = sha256(seed) hex; config.seed := "season:<id>" (the real seed never enters report.json)
packages/cli/src/spawn.ts            --agent-uid: spawn with {uid, gid} (Linux + root only; else exit 2 with a clear error)
packages/scorer/src/redact.ts        NEW pure: redact(report) → report@3-redacted (ADR-011 / application-design v3)
packages/cli/src/run.ts              ONLY: --redact writes report.redacted.json
packages/leaderboard/src/provenance.ts NEW: tier classification; verifier is INJECTED: (resultPath, bundlePath, expectedSignerWorkflow) → Promise<boolean>
packages/leaderboard/src/build-leaderboard.ts  tiers: "Ranked (held-out season <id>)", "Verified (public corpus)", Tier 3 per user decision (default rejected);
                                     redacted reports accepted ONLY in Tier 1 (no re-score possible; provenance is the evidence)
packages/leaderboard/src/main.ts     offline default verifier = "unverified" (Tier 3); --verify-attestations uses `gh attestation verify --bundle … --signer-workflow …`
results/_harness.json                release allowlist of harness_commit values (filled with the release commit at G7)
results/** , LEADERBOARD.md          regenerated LAST: guardrail track = allow-all, deny-all (INVALID section), reference-policy (kind reference); agent track = none committed
.github/workflows/rank.yml           NEW reusable (workflow_call): inputs guardrail cmd, guardrail-id, ref; runs canonical guardrail track on public corpus;
                                     actions/attest-build-provenance on report.json; uploads report + bundle. permissions: id-token: write, attestations: write
.github/workflows/ranked-run.yml     NEW (workflow_dispatch, maintainers only via environment protection "ranked"): checkout guardrail repo@sha;
                                     fetch held-out corpus bundle (private repo, deploy key secret), age-decrypt (key secret) inside container;
                                     docker run --network none; harness as root, --agent-uid 1001, corpus 0400; publish ONLY report.redacted.json + attestation
.github/ranked/Dockerfile            NEW: node 20 + pnpm via corepack + harness at the release commit; `age` binary installed in the image build (not on the host)
CONTRIBUTING.md                      tiers, how to call rank.yml, season rules (environment detection forbidden; open-source + pinned SHA for Tier 1)
README.md                            "Leaderboard" section only
docs/seasons.md                      NEW: season lifecycle (commitment at start, reveal seed + corpus at end, merge into public corpus)
```

## 3. Rules
- The real seed never appears in `report.json`, the logs, `task.json` or the env passed to the agent. The agent wallet is derived from the seed, and the public key is fine. A unit test greps every written file for the seed.
- Season reports also carry `corpus_hash`, the hash of the held-out corpus, which is publishable.
- In Tier 2, attestation checks are added on top of every U13/U16 acceptance check; they never replace them.
- The leaderboard build stays **offline and deterministic** by default (CI diff-check). Attestation verification is a separate CI job that writes `results/_verified.json`, `{<id>: {tier, signer, run_url}}`, which the build reads.

## 4. Acceptance tests
**Developer (each < 3 min):**
- `season.test.ts`: the seed comes from env; `config.seed === "season:s1"`; the commitment matches; and the seed string appears in no written file (scan the out dir).
- `redact.test.ts`: no `runs`, prompts, host names or violation messages, and the summary is unchanged.
- `spawn` with `--agent-uid` on macOS or as non-root → exit 2 with the message.
- Leaderboard: a fixture redacted report with `_verified` tier 1 → ranked; the same without `_verified` → rejected; a Tier 2 attested full report → "Verified" table, not ranked; Tier 3 → rejected (default).
- `rank.yml` and `ranked-run.yml` parse as YAML. `act` and actionlint are **not** installed and must not be installed (CLAUDE.md).
- Probe: `--season-seed-env S --scenario price-bait` with `S=testseed` runs, and `grep -r testseed <out>` is empty.

**Orchestrator:**
- regenerate results with U18's guardrails and run `pnpm leaderboard`;
- the CI diff is green;
- E2E.

**Real runner (U22):** both workflows.

## 5. Do not
- Commit any secret, held-out scenario, age key or real seed. Test seeds are literal strings in tests only.
- Make network calls from `pnpm leaderboard` or any unit test.
- Publish, push, or create repos or environments (user decisions).
- Put agent or guardrail logs into uploaded artifacts in `ranked-run.yml`.
- Install `age`, docker, `act` or actionlint locally.
- Commit, except the single worktree commit.
