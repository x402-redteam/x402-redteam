import type { Chain } from "./scenario.js";

export interface ChainDefaults {
  network: string;
  asset: string;
  decimals: number;
  extra: Record<string, unknown>;
}

/**
 * Chain defaults per application-design.md §3 "Chain defaults" table.
 * `extra.feePayer` for svm is filled lazily by callers that have access to the
 * harness facilitator canary (this module has no dependency on canary.ts to
 * avoid a cycle); callers should merge it in.
 */
export const CHAIN_DEFAULTS: Record<Chain, ChainDefaults> = {
  evm: {
    network: "eip155:84532",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    decimals: 6,
    extra: { name: "USDC", version: "2" },
  },
  svm: {
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    extra: {},
  },
};

/**
 * Converts a USD amount to the atomic (integer, smallest-unit) string
 * representation for the given number of decimals, without float drift.
 *
 * Uses pure string/BigInt arithmetic on the decimal digits so that values
 * like 0.1 + 0.2 (which is not exactly 0.3 in IEEE-754) are handled
 * correctly when passed in as a pre-summed number: the number is first
 * rendered with a bounded number of decimal digits via toFixed, which
 * itself rounds to the nearest representable decimal - this is the
 * standard mitigation for float drift in USD amounts.
 */
export function usdToAtomic(usd: number, decimals: number): string {
  if (!Number.isFinite(usd)) {
    throw new RangeError(`usdToAtomic: usd must be finite, got ${usd}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`usdToAtomic: decimals must be a non-negative integer, got ${decimals}`);
  }
  const negative = usd < 0;
  const fixed = Math.abs(usd).toFixed(decimals);
  const [whole, frac = ""] = fixed.split(".");
  const digits = `${whole}${frac.padEnd(decimals, "0")}`;
  const atomic = BigInt(digits === "" ? "0" : digits);
  return (negative ? -atomic : atomic).toString();
}

/** Converts an atomic (integer, smallest-unit) string back to a USD number. */
export function atomicToUsd(atomic: string, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`atomicToUsd: decimals must be a non-negative integer, got ${decimals}`);
  }
  const negative = atomic.startsWith("-");
  const digits = negative ? atomic.slice(1) : atomic;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const frac = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  const value = Number(`${whole}${frac ? `.${frac}` : ""}`);
  return negative ? -value : value;
}

/**
 * The harness's fixed Solana blockhash. The mock RPC serves it, and
 * recordTransfer / challenges use it, so every SVM transaction is deterministic.
 */
export const FIXED_BLOCKHASH = "11111111111111111111111111111111";
