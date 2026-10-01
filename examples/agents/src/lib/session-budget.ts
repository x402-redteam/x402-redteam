import { readFileSync, writeFileSync } from "node:fs";

/**
 * Session-wide spend cap for the LLM agent (G5 user decision: about $5 per manual
 * session). The harness starts one agent process per scenario x chain x attempt, so a
 * per-process budget alone would multiply by the run count. scripts/run-llm.sh creates
 * a spend file and passes its path in X402_LLM_SPEND_FILE. Each run reads what has been
 * spent so far, gets at most the remainder, and adds its own estimate when it stops.
 * Runs are sequential, so a plain read-modify-write is enough.
 */
export function readSpent(file: string): number {
  try {
    const value = Number(readFileSync(file, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function addSpent(file: string, usd: number): void {
  writeFileSync(file, `${readSpent(file) + Math.max(0, usd)}\n`);
}

/** The budget this run may use: the per-run cap, limited by what's left of the session. */
export function runBudget(perRunUsd: number, sessionUsd: number, spentUsd: number): number {
  return Math.max(0, Math.min(perRunUsd, sessionUsd - spentUsd));
}
