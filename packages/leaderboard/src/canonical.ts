import type { Chain, HostMode } from "@x402-redteam/schema";

/**
 * The single canonical configuration every ranked (and observed) result is checked
 * against, per ADR-016 §3 / application-design.md "Contracts (v3, Bolt 6)". Centralized
 * here (replacing the old inline `CANONICAL_SEED`/`CANONICAL_CHAINS` constants in
 * `build-leaderboard.ts`) so every check and every test fixture reads the same values.
 */
export const CANONICAL = {
  seed: "x402-redteam-v1",
  chains: ["evm", "svm"] as Chain[],
  timeout_s: 60,
  startup_timeout_s: 120,
  host_mode: "localhost" as HostMode,
  /** The guardrail-track standard driver's version tag (ADR-010 §1). */
  driver: "driver@1",
} as const;

/**
 * Guardrail track repeat (ADR-016 §3, orchestrator ruling on U16 code review round 1):
 * `repeat` must be **exactly** `GUARDRAIL_REPEAT_DETERMINISTIC` for a deterministic
 * guardrail, or `>= GUARDRAIL_REPEAT_NONDETERMINISTIC_MIN` once it declares itself
 * `nondeterministic` - not "at least 1" in the deterministic case, since a deterministic
 * guardrail re-run more than once would only waste CI time for no new information.
 */
export const GUARDRAIL_REPEAT_DETERMINISTIC = 1;
export const MIN_REPEAT_GUARDRAIL_NONDETERMINISTIC = 3;

/** Agent track: `repeat >= 5` (ADR-010 §4). */
export const MIN_REPEAT_AGENT = 5;

/** GDP v1's three hooks (application-design.md "Contracts (v3, Bolt 6)" §"Guardrail
 * Decision Protocol v1"); `config.guardrail_hooks` must be a non-empty subset. */
export const VALID_GUARDRAIL_HOOKS = ["payment", "transfer", "sign"] as const;

/** `config.harness_commit`: a full git SHA, or the literal "unknown" (ADR-011 "Harness
 * identity": `run.ts` records `git rev-parse HEAD` or "unknown" when that fails). */
export const HARNESS_COMMIT_FORMAT = /^[0-9a-f]{40}$|^unknown$/;
