/**
 * U38 (ADR-010 amendment): the standard driver's hard per-run budget, kept below every adversary
 * cap (`MAX_RUN_REQUESTS` 1,000, `MAX_RUN_PAYMENTS` 200) so a limit hit on the guardrail track
 * is never the driver's own doing. On exhaustion the driver stops starting new work, finishes
 * the step in flight, records `budget_exhausted: true` and exits 0; the harness then treats the
 * run as an error, never a pass (it is not a resource-limit hit and is not scored).
 */
export const DRIVER_MAX_REQUESTS = 400;
export const DRIVER_MAX_LEGS = 100;

interface BudgetState {
  /** Only `installBudget()` (the driver's `main()`) turns the budget on; unit tests are never limited. */
  active: boolean;
  requests: number;
  legs: number;
  exhausted: boolean;
}

export const budget: BudgetState = { active: false, requests: 0, legs: 0, exhausted: false };

/**
 * Wraps `globalThis.fetch` so every HTTP request the driver process sends (crawl, paid retries,
 * RPC through viem or `@solana/kit`, shim ledger posts) is counted. Called first in `main()`.
 */
export function installBudget(): void {
  budget.active = true;
  budget.requests = 0;
  budget.legs = 0;
  budget.exhausted = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (budget.requests >= DRIVER_MAX_REQUESTS) {
      budget.exhausted = true;
      return Promise.reject(new Error("driver request budget exhausted"));
    }
    budget.requests += 1;
    return realFetch(input, init);
  }) as typeof fetch;
}

/** Counts one payment, transfer or sign leg the driver acts on after an allow; false when spent. */
export function takeLeg(): boolean {
  if (!budget.active) return true;
  if (budget.legs >= DRIVER_MAX_LEGS) {
    budget.exhausted = true;
    return false;
  }
  budget.legs += 1;
  return true;
}
