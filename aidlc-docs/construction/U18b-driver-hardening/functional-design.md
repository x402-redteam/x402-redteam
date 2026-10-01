# U18b: Driver hardening follow-ups · Functional Design

Author: Opus (orchestrator) · Implementer: Sonnet · Bolt 6 Phase B2 (runs in parallel with U20 and U21)
Source: U18 re-review on main (merge 658ac57). The 5 blockers are closed; these items remain.

## Items
1. **Guardrail can't reach the driver's record (medium).** Spawn the guardrail with `cwd` set to a fresh temp dir. Better: deliver the driver's run record (`guardrail_errors`, `hooks`, `nondeterministic`) to the harness through a channel the guardrail can't write, either the driver's own stdout framed with a sentinel line or fd 3, instead of `out/runs/<run_id>.gdp.json`. If you keep the file, the driver must write it only *after* the guardrail process has exited, and the harness must ignore the file whenever the driver's exit code is non-zero. Document the residual risk (a guardrail running as the same user).
2. **The error count must be visible in ranked, redacted reports.**
   - Add `summary.guardrail_errors` (the total over runs; `null` off the guardrail track).
   - Show it in the markdown summary and as a leaderboard column on the guardrail table.
   - `readGuardrailErrors` returns `undefined` when the record is missing (for example after a failed `hello`), never `0`.
   - The scorer and leaderboard files are orchestrator-authorized for this.
3. **Tests:**
   - hook disagreement across runs leads to `hooks: null` and the leaderboard rejecting the report;
   - `nondeterministic` is the OR across runs;
   - a stale record is deleted before the spawn;
   - a missing record with exit 0 becomes exit 1;
   - a failed `hello` gives `guardrail_errors` undefined;
   - the guardrail's cwd is not the harness out dir.
4. **intent.ts, Solana address pattern:** add word boundaries and reject strings that are all hex. Test: "hash 9f8e…a3 and fee $1" must produce no svm intent.

## Constraints
- Short commands only: `pnpm test`, targeted vitest, and single-scenario `--guardrail` probes.
- No `test:e2e` and no calibration runs.
- One commit on your worktree branch.

## 5. Calibration failure (orchestrator, E2E after B1 merge): BLOCKING
`driver-calibration.e2e.test.ts`: reference-policy fails **price-bait-2** on both chains (deterministic), overpaying $0.02 against an advertised $0.002.
- **Cause:** `/translate/run` is a prompt (seed) URL, so the driver fetches it with the seed referrer `{url:""}`. The pricing page that advertises the price is never passed as context, and the policy's advertised-price check sees no text.
- **Fix (driver, ADR-010 §3, maximally-attempting with realistic context):** a URL's referrer is the **most recently fetched page whose body links to that URL**, whether that URL is a seed or was discovered. Only when no fetched page links to it does it get the seed referrer.
- **Fetch order:** process seeds in prompt order, and re-evaluate the referrer at the moment of each fetch.
- **Tests:**
  - unit: a seed that is linked from an earlier seed gets that page as its referrer;
  - single-scenario probe: reference-policy passes price-bait-2 on both chains, and allow-all still fails it.
- **Do not** special-case price-bait or any scenario id.
