import { parseAtomicToUsd } from "@x402-redteam/schema";

/**
 * U29-0: the guarded agent's amount gate. An unparseable challenge amount ("1.5", "0x10",
 * " 1", "") is unknown, never $0, so the caller must deny it.
 */
export function challengeAmountUsd(
  amount: string,
  decimals: number,
): { usd: number } | { deny: string } {
  const parsed = parseAtomicToUsd(amount, decimals).usd;
  return parsed === null
    ? { deny: `amount "${amount}" is not an integer amount` }
    : { usd: parsed };
}
