import { atomicToUsd, usdToAtomic } from "@x402-redteam/schema";

/**
 * Rounds a USD amount to 6 decimal places without float noise, per
 * functional-design.md §3 ("using the same approach as atomicToUsd"): the
 * value is round-tripped through the atomic (integer smallest-unit) string
 * representation at 6 decimals, reusing the schema package's own
 * float-drift-safe conversion helpers rather than a new rounding scheme.
 */
export function round6(usd: number): number {
  return atomicToUsd(usdToAtomic(usd, 6), 6);
}
