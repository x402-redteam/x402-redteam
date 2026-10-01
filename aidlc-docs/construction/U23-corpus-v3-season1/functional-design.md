# U23 — Public corpus v3 (≥ 3 variants per category) and the Season 1 held-out corpus · Functional Design

Author: senior-architect · Implementers: **two different Sonnet agents** (U23-public, U23-heldout). Neither may have written `examples/agents/src/guarded.ts`, `examples/guardrails/reference-policy.ts`, or the driver's `intent.ts`, and neither may read them (ADR-011 admission rule).
Bolt 6 **Phase C**, after U18 is merged. Calibration needs the driver.

## 1. Goal
- The **public corpus** reaches ≥ 3 variants per attack category. Today accepts_ordering, asset_swap, authorization_lifetime, budget_split, challenge_injection and resource_spoof have 1 each, and most others have 2.
- New variants include a SetAuthority drain (it needs U21).
- A **Season 1 held-out corpus**, written outside the repo, gives the first Tier 1 ranking. It has ≥ 2 scenarios per category, all new.

## 2. Files
```
U23-public (owned in Phase C):
  corpus/<category>/*.yaml           new variants; each with reach_class, surface route(s), a one-paragraph rationale naming the documented attack;
                                     prompts never name the attack (CONTRIBUTING rule)
  corpus/README.md                   variant table
  packages/cli/test/corpus-hash.test.ts   re-pin
  packages/cli/test/corpus-v2.e2e.test.ts  (now corpus-level counts only; owned from U15)
U23-heldout (writes ONLY to the directory given in env X402_HELDOUT_DIR, OUTSIDE the repo; never to the repo, never to aidlc-docs):
  $X402_HELDOUT_DIR/corpus/**        same schema; `x402-redteam validate --corpus $X402_HELDOUT_DIR/corpus` passes
  $X402_HELDOUT_DIR/AUTHORING.md     rationale per scenario (stays private until the season reveal)
```

## 3. Rules
- Calibration admission for every new scenario, public and held-out:
  - `validate` passes;
  - the U18 intent-extractor unit test covers it when it is prose-class;
  - **allow-all fails it and deny-all passes it** on every chain it declares.
- The orchestrator runs that calibration, scenario by scenario with `--scenario`, so each command stays short.
- Hostnames: reserved TLDs only (lint 6).
- Canaries: never reused across channels (lint 3).
- Held-out scenarios must not be trivially fingerprintable from public ones:
  - no copied prompts or hostnames;
  - vary the route paths, amounts and page structure.
- The held-out corpus carries its own ≥ 2 controls, so validity is judged on the season's own corpus and not only on the public controls.
- At least one held-out scenario per reach_class must be *structurally new*, not a re-skin of a public one.

## 4. Acceptance tests
**Developer (each < 2 min):** `validate` (public and held-out), `pnpm test`, and per-scenario targeted probes with allow-all and deny-all (≈ 1 min each). Do at most 5 per command batch, and report the list.

**Orchestrator:** full calibration E2E over the public corpus (U18's test) and `--corpus $X402_HELDOUT_DIR/corpus` with allow-all, deny-all and reference-policy. reference-policy failures on held-out are **expected and reported, not fixed**; they show the corpus generalises.

## 5. Do not
- Read or edit the reference policies or the driver.
- Write held-out material anywhere inside the repo, the audit log or any message to the orchestrator beyond counts and ids.
- Tune a scenario until reference-policy passes it.
- Commit held-out files, ever.
- Commit, except the single worktree commit (U23-public only).
