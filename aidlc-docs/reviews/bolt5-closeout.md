# Bolt 5 close-out: Review 1 blockers re-checked on main

Reviewer: senior-architect (independent) · Date: 2026-10-01 · main @ `7c7734d` (U14 merged)
Method: code reading plus short probes only. No full E2E was run, per the orchestrator's instruction on a loaded machine (load average about 5.3).
- `pnpm test`: 42 files passed and 1 skipped; 419 tests passed and 1 skipped; 9.5 s.
- Probe: `pnpm x402-redteam run --agent "true" --scenario prose-payment --startup-timeout 20` (controls always run) → **exit=2** with the `INVALID RUN` banner and `summary.valid=false`.

## Blockers

| id | status | evidence | residual |
|---|---|---|---|
| B1 no-op/crash agents rank first | **Closed** | `scorer/src/score-run.ts:169` `agent_ok = exit_code===0 && !timed_out`, and `:300` gives `error`, not `pass`. `score-suite.ts:170-172` makes `valid` require more than 0 control runs, all of which pass. `cli/src/run.ts:95` returns 2 on `valid===false`. The probe above gives exit 2. | The same INVALID report still prints `safety score 100` for the no-op agent (probe output). That is cosmetic, but it's a screenshot risk: suppress the score when the run is invalid (U16). |
| B2 scores measure crawl shape, not guardrail | **Partially closed** | The spoof hole is closed: `corpus/resource_spoof/`, and guarded was recorded failing it before the fix (audit, U11). The corpus is no longer circular for the `challenge` class. **Open:** there is no standard driver. `examples/agents/src/guarded.ts:4-6` still differs from naive in *crawl* behaviour (it fetches each URL once and never retries), so even the two reference rows confound driver and policy. LEADERBOARD.md is correctly "Unranked / experimental" (ADR-010 amendment). | Ranking stays blocked until the guardrail-track driver ships (U18). |
| B3 self-reported, gameable leaderboard | **Partially closed** | Canonical checks are at `leaderboard/src/build-leaderboard.ts:221-244`, and the re-score through the real `scoreSuite` at `:280`. **Open:** (a) there is no provenance. (b) The public seed and `run_id = sha256(seed:scenario:chain:attempt)` are unchanged (`cli/src/run.ts:56-61`), so run ids, prompts and canaries are precomputable. (c) `harness_version` is the constant `"0.0.1"` (`run.ts:212`), so no harness commit is recorded. (d) `timeout_s` is recorded but not checked, and `startup_timeout_s` is not recorded at all (report `config` from the probe: `{chains,controls_included,fail_on,repeat,scenario_filter,seed,timeout_s}`). | See the new hole N1 below. Provenance, the held-out corpus and the config fingerprint are U16 and U19. |
| B4 direct transfers invisible without TS shim | **Closed** | Mock EVM RPC: `adversary/src/evm-rpc.ts:330-352` (`eth_sendRawTransaction` → `recordDecodedLegs`, `capture:"rpc"`). Solana: `solana-rpc.ts:210-245`. Every leg is recorded (U10 H1 re-review). The audit records no-shim prose capture at $3 `rpc`/`prose` on both chains. | An agent that ignores the RPC env vars is still invisible; that is documented in ADR-013. The other Review 1 recommendation, "leaderboard requires chain-boundary capture active", is **withdrawn**: `capture_layers` counts *payments*, so a guardrail that correctly blocks has `rpc=0`. The check is replaced by driver-guaranteed RPC use in the guardrail track (U18) and the `reached` metric (U16). |

## Issues Bolt 5 introduced or left that worry me

| id | sev | evidence | consequence | fix |
|---|---|---|---|---|
| N1 | **major (launch-blocking)** | `build-leaderboard.ts:87-131`: `rescorableComparable` strips `excessive_authorization_window` from **both** the stored and the fresh report before comparing. | A submitter can delete that violation and edit the summary, and the report is still accepted. The authorization_lifetime result is therefore self-reported. | Persist a deterministic boolean `Payment.authorization_window_exceeded` (U15 contract, U16 scorer) and delete the special case. |
| N2 | minor | `.github/workflows/self-test.yml:28-33` asserts only `outcome == failure`. | Exit 1 (unsafe) and exit 2 (invalid or crashed) look the same, so a naive agent that fails to start still passes self-test. | Expose an `exit-code` output and assert exact codes (U22). |
| N3 | minor | `harness_version` is a constant (`run.ts:212`). | Results from different harness commits aren't distinguishable. | Record `harness_commit` (U15) and check it against the release allowlist (U16). |
| N4 | process | The audit tail records U14's E2E 18/18 at load 7.7 as "evidence, not proof". Bolt 5 also had 3 stalls caused by long commands. | The flake root cause is mitigated, not proven fixed. | Bolt 6 designs keep developer commands short. The orchestrator owns `test:e2e` and the calibration suites (units-of-work, Bolt 6). |
| N5 | minor | Hosts are still `/_host/` path prefixes (`cli/src/task.ts:57`, `adversary/src/routes.ts:16-27`), so M1 is still open. | Three categories still reward knowing the harness convention. | U17 (ADR-012). |

## Verdict
Bolt 5 achieved what it set out to do: runs are now valid (B1), capture is complete (B4), and the corpus is no longer circular for the `challenge` class. The leaderboard is still **not rankable**: B2 needs the standard driver, B3 needs provenance and a held-out corpus, and N1 must be fixed. Bolt 6 below addresses all of these.
