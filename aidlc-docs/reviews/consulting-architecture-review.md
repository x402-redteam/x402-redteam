# Consulting architecture review — x402-redteam (2026-10-31)

Scope: the whole repository at local `main` (v0.1.0 plus U31–U33-1, unpushed), four lenses run in
parallel by read-only reviewers and consolidated by the orchestrator: measurement validity,
security and isolation, maintainability, product and go-to-market. The private repository was not
read; nothing here names a third-party finding, scenario or result (ADR-028). Claims marked
**verified** were re-checked by the orchestrator against the cited lines.

## Verdict

The core is sound. The per-run verdict pipeline (total decoder → attribution → pure scorer →
re-scoreable report) is well designed, deterministic and honest about its limits, and the
security posture of CI, release and the agent spawn contract is unusually mature for a v0.1.
The weaknesses are at the edges, and they are the edges the business depends on:

1. **What the published numbers can support.** Tier 2 can be forged or overfit, refusal is cheap
   to score well on, and the headline safety score is driven by corpus composition.
2. **Whether anyone can submit.** The leaderboard has no external entries and is, today,
   structurally closed to agent developers.
3. **Whether it scales to more adapters, rails and transports** without the security-critical
   sandbox code and the contract docs drifting.

No finding makes a committed reference result wrong.

## Findings

Severity is the consolidated view across lenses. "Lens" names where the finding came from.

### High

| ID | Lens | Finding | Evidence | Recommended change |
|---|---|---|---|---|
| H1 | Security | **Tier 2 attestation signs an artifact other jobs in the submitter's workflow run can replace** (verified). `attest` downloads `report-<id>` by name and attests it; no digest is carried from `run`. The submitter owns the caller workflow, so a parallel job can swap the artifact. Re-score only checks the report against its own `runs[]`, which can be fabricated together. | `.github/workflows/rank.yml:210-235`; `packages/leaderboard/src/build-leaderboard.ts:626` | Hash `report.json` in `run`, pass the digest as a job output, and fail `attest` on mismatch. Same pattern in `ranked-run.yml`. |
| H2 | Validity | **Tier 2 is ranked on a public seed, so a guardrail can be fit to it.** Canaries (legit/attacker addresses) and run ids are derivable from `x402-redteam-v1`, and the driver hello includes the wallet address. | `packages/leaderboard/src/canonical.ts:10`; `packages/cli/src/run.ts:173`; `build-leaderboard.ts:1202-1205` | Show Tier 2 unranked, or run it with a fresh per-run seed committed in the report. Label it a regression result. |
| H3 | Validity | **Refusal is cheap.** Several `allow: true` attacks can only be passed by not paying (verified: `price-bait` is `allow: true, max_usd: 0.001` against a $1.00 challenge). There are only 7 controls; `valid` is all-or-nothing and ranking ignores utility. An over-blocking policy ranks level with a precise one. | `corpus/price-bait.yaml:28-36`; `packages/scorer/src/score-suite.ts:177`; `build-leaderboard.ts:1184-1191` | Grow a benign-but-unusual control battery (≥20), rank and tie-break on utility, and relabel refusal-only scenarios `allow: false`. |
| H4 | Validity | **Declared determinism decides how many attempts count, and honesty is penalised.** A guardrail that says it is deterministic gets one draw; one that says it is not gets worst-of-3. Nothing verifies the declaration. | `canonical.ts:27-28`; `build-leaderboard.ts:481-494`; `score-suite.ts:44-50` | Re-run guardrails declared deterministic and require identical verdicts; rank on a pass rate with a Wilson interval. |
| H5 | Validity | **Unobserved channels read as pass on the agent track.** A payment sent outside the harness (own RPC transport) is invisible; the run passes. | ADR-013 residual; `score-suite.ts:201-216` | Egress canary on agent-track runs (deny egress, fail as `unobserved_egress`), or label agent-track passes "no observed payment". |
| H6 | Product | **The leaderboard is closed to its stated audience.** Only stdio GDP guardrails rank; agents are never ranked; Season 1 does not exist; and since U31, Tier 2 cannot accept any report until a new release is allowlisted. Every row today is a reference oracle. | `LEADERBOARD.md`; `CHANGELOG.md` [Unreleased]; `results/_harness.json` | Cut v0.1.1 and allowlist it; seed consented real stacks and an "SDK defaults" baseline table; add a stack/agent submission path and a thin "wrap my payment function as a guardrail" shim. |
| H7 | Maintain. | **The third-party sandbox and guard are copied per adapter and have already diverged** (AgentKit lacks the port pinning and fresh `HOME` that ClawRouter and Cloudflare have). This is the security boundary for running third-party code; two more adapters are planned. | `examples/third-party/*/src/{sandbox,guard}.ts` (190/216/205 and 281/308/302 lines); agentkit `sandbox.ts:61` | Extract a zero-dependency `@x402-redteam/sandbox` consumed by `file:`, or a byte-sync check plus a shared conformance canary; back-port port pinning and fresh `HOME` to AgentKit now. |
| H8 | Product | **Reports explain the attack but not the fix, and are not client-ready.** No remediation field, no plain verdict line, test-artifact figures (e.g. trillion-x overpay) read as noise. | `packages/scorer/src/markdown-reporter.ts:27-34,105-118` | `remediation`/`references` per category, a plain verdict header, and a `--format client` report with scope, method, version and limitations. |

### Medium

| ID | Lens | Finding | Evidence | Recommended change |
|---|---|---|---|---|
| M1 | Validity | EVM dedupe key is the nonce alone, so two authorizations with one nonce and different payees merge into one ledger entry (verified). | `packages/capture/src/evm.ts:287`; `merge.ts:44-61` | Key on nonce, from, to, asset, network, amount and signature hash; merge only layers of the same signature; regression test. |
| M2 | Validity | Controls accept a signature valid only against the client's own copy of the terms, which a chain would reject (verified, by design since U29-0). | `evm.ts:324-328`; `facilitator.ts` | Require `terms_verified === "offered"` for control payments; add HTTP settle-fail/slow-settle behaviours. |
| M3 | Validity | Safety score weights per scenario-variant, so it follows corpus composition; the `$` tie-break saturates at the wallet cap; summed exposure across wallets is not a real loss. | `score-suite.ts:115-118` | Make per-category pass rates primary; weight by category; require a pass on every critical scenario to rank. |
| M4 | Validity | Circularity: corpus admission depends on the driver's regex extractor and the reference policy, both by the same authors as the held-out set. | ADR-010 §3; `packages/driver/src/intent.ts:109-123` | Independent held-out authors; an agent-only prose set outside the extractor; publish extractor recall. |
| M5 | Validity | All-or-nothing `valid` with no record of attempts biases the agent track to survivor reruns; runs share real `HOME` and one wallet. | `build-leaderboard.ts:520-526`; `run.ts:184-201` | Record `runs_started`; fresh `HOME` and wallet per run; per-season randomised order. |
| M6 | Security | Ranked containers run untrusted guardrails with no hardening (`--cap-drop`, `no-new-privileges`, pids/memory limits, read-only root); `rank.yml` also omits `--network none`; no `timeout-minutes` on `ranked-run`. | `ranked-run.yml:210-227`; `rank.yml:191-203` | Add the flags and a job timeout. |
| M7 | Security | Adapter child can likely read the parent's environment (incl. the Anthropic key) as a same-uid process, and can write the out dir and the LLM spend file (cap bypass). Unverified on the process-info read. | agentkit `agent.ts:289-299`, `sandbox.ts:58-91`; `scripts/run-llm.sh:30` | Canary probe for the parent env; deny process-info if visible; out dir read-only to the child; spend file outside the writable set. |
| M8 | Security | `heldout-guard` fails open without its key, is not part of `ci-ok`, and runs the PR's own workflow file with the secret available to same-repo branches. | `scripts/heldout-guard-ci.mjs:146-149`; `heldout-guard.yml` | Fail closed on same-repo events; restrict the `guard` environment to `main`; make it required. |
| M9 | Security | Adversary request bodies and JSON-RPC batches are unbounded outside one route; the server shares the harness event loop, so a hostile agent can stall past its timeout. | `ledger-endpoint.ts:13` (verified); `evm-rpc.ts:352-359`; `mcp-server.ts:100-105`; `proxy.ts:40-48` | Global `bodyLimit`, batch cap, per-run request/payment caps; stream-count the MCP body. |
| M10 | Security | CI never exercises the ranked pipeline or the adapter sandboxes; those paths are not classified as runtime. | `scripts/ci-changes.mjs:10-24`; workflow headers "NOT verified live" | Treat them as runtime; a PR job that builds the image with a synthetic key and asserts only the redacted report leaves; run adapter canaries on the macOS runner. |
| M11 | Maintain. | Corpus hash depends on parsed schema output, so one stray zod `.default()` stales every result; the rule is enforced by comments only. | `score-suite.ts:38-42`; `schema/src/scenario.ts` | A test that pins each corpus's hash to a committed constant. |
| M12 | Maintain. | Version sprawl: report@3 across contract v1–v7, driver tag duplicated in three places, no single registry; `application-design.md` needs seven overlays to read. | `build-leaderboard.ts:220-234`; `cli/src/guardrail-track.ts:15`; `leaderboard/src/canonical.ts:17` | One constants module; a `semantics` integer in report config; a current-state `CURRENT.md` with ADR status. |
| M13 | Maintain. | Hot spots: `build-leaderboard.ts` (1458 lines, with a cloned MCP pipeline), `load.ts` (1002), `scoreRun` (~205-line function); `schema` drags viem and Solana into scorer and leaderboard. | file sizes as cited | Split leaderboard into acceptance/rank/render/section specs before another track; extract `@x402-redteam/corpus`. |
| M14 | Maintain. | Rail and transport seams are half built: MCP methods on `Rail` are optional; `Transport` is not an interface; capture and scorer assume x402 shapes. A new transport touches 15–25 files. | `adversary/src/rails/rail.ts:114-138`; `routes.ts:43-45` | Make the transport seam explicit before MPP or a third transport. |
| M15 | Product | Distribution: no npm package, no general-purpose image (the only image is the ranked one), heavy Action install. Non-Node agents face the most friction. | `README.md:36`; `.github/ranked/Dockerfile`; `action.yml:143-146` | A plain run image; reconsider the deferred npm bundle (U24-G). |
| M16 | Product | "Agent-agnostic" holds for the wire but not the form factor: agents with custodial/MPC wallets, hosted agents and framework agents need wrappers the docs do not show. | `README.md:129-292` | A supported-agent matrix and 4–6 framework recipes with verified results. |
| M17 | Product | The audit offer is not productised (no scope, terms, intake, retest); a solo maintainer with AI-only review is a procurement risk. | `SUPPORT.md:13-17`; `GOVERNANCE.md:29-43` | A one-page audit offer and engagement template; a second maintainer or external corpus reviewer before Season 1. |
| M18 | Product | Positioning: most confirmed issues sit in published SDKs, not agents. | reference results; private triage counts | Reposition as a payment-stack regression suite with per-failure layer attribution (SDK default / guardrail / model / not stopped) and an SDK-version matrix mode. |

### Low (recorded, not proposed for work)

Same-uid guardrail and driver (documented residual); held-out totals as a covert channel (cap
submissions per season); `--pass-env` does not reject season secrets; held-out deploy key lives
for the whole job; task/run files world-readable and `runs/` unscrubbed; public default-seed key
derivable (one README line); Dependabot version updates miss the adapter lockfiles and the `age`
binary (security alerts do cover the lockfiles); the loopback ledger accepts a browser blind
POST; `authorization_seconds` measured at receipt; attribution is diagnostic only; GDP fail-closed
assumed; the `prose-payment` prompt invites acting on page text; `/facilitator/verify` records a
header payment; fuzz spec quotes not checked against the pinned spec; small duplications
(`isRecord`, `logRequest`, the harness-commit regex); `--redact` input documented as not
implemented; the private directory names appear in public deny lists and comments.

## Strengths to keep

- Pure, re-scoreable scorer with canonical JSON and byte determinism; worst-case aggregation; the
  control gate that makes a do-nothing agent invalid; U31's strict repeat reach.
- Total, conservative capture: decode errors kept, legs partitioned by scheme, exposure capped
  per run.
- Process boundary for agents and the driver; allowlist-built child env; fresh adversary per run.
- CI and release: SHA-pinned actions, least-privilege jobs, no `pull_request_target`, attestations
  in jobs that never run untrusted code, digest-pinned images verified before use.
- Exact pins, release-age gate, lifecycle scripts off, documented overrides.
- Privacy discipline: redacted reports, quiet output, HMAC and fuzz guards.
- Honest documentation of circularity, reach limits and residual risks.

## Ranked follow-up units (each needs the usual design, review and owner gate)

| Rank | Unit | Covers | Size |
|---|---|---|---|
| 1 | **Tier 2 integrity:** report digest from `run` to `attest`; Tier 2 unranked or per-run seed; container hardening and job timeout | H1, H2, M6 | S |
| 2 | **Release v0.1.1 and allowlist** so Tier 2 can accept a report again (includes the batch now on local `main`) | H6 (part) | S |
| 3 | **Shared sandbox package** plus a conformance canary; back-port port pinning and fresh `HOME` to AgentKit; parent-env probe; out dir read-only to the child | H7, M7 | M |
| 4 | **Scoring credibility:** control battery ≥20, utility ranked, refusal-only scenarios relabelled, per-category primary results, determinism re-check | H3, H4, M3 | L |
| 5 | **Capture fixes:** full dedupe key; offered-terms validity for controls | M1, M2 | S |
| 6 | **Adversary resource limits** | M9 | S |
| 7 | **Client report and remediation fields** | H8 | M |
| 8 | **Distribution:** plain run image, npm bundle decision, framework recipes | M15, M16 | M |
| 9 | **CI coverage of ranked pipeline and adapters**; held-out guard fail-closed and required | M8, M10 | M |
| 10 | **Maintainability:** corpus-hash pin test, version constants, leaderboard split, transport seam (before any new rail or transport) | M11–M14 | M–L |
| — | **Owner and business decisions, not code:** audit offer and terms, second maintainer, positioning, Season 1 | M17, M18, H6 (rest), M4 | — |

Agent-track items (H5, M5) wait until an agent is submitted.
