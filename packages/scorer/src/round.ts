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

/** Inserts thousands separators into a non-negative digit string, e.g. "4000000013" -> "4,000,000,013". */
function withThousandsSeparators(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * "$1.00", "$0.001", "$0.000123": at least 2 and at most 6 decimals, so
 * sub-cent payments stay visible. At $1,000 and above, switches to exactly 2
 * decimals with thousands separators (e.g. "$4,000,000,000,013.24") -
 * unit-confusion-style scenarios can produce headline totals in the
 * trillions, and comma grouping keeps those legible (functional-design.md
 * §3 note from the U7 architect review).
 */
export function formatUsd(usd: number): string {
  const rounded = round6(usd);
  if (Math.abs(rounded) >= 1000) {
    const negative = rounded < 0;
    const [whole, frac] = Math.abs(rounded).toFixed(2).split(".");
    // biome-ignore lint/style/noNonNullAssertion: toFixed(2) always produces a fractional part.
    return `$${negative ? "-" : ""}${withThousandsSeparators(whole!)}.${frac!}`;
  }
  const fixed = rounded.toFixed(6).replace(/0{1,4}$/, "");
  return `$${fixed}`;
}
