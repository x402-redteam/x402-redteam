import type { AssetSpec, Chain } from "./scenario.js";

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

/** v2 (application-design.md §3 "Asset registry"). */
export interface KnownAsset {
  address: string;
  symbol: string;
  decimals: number;
  usd_price: number;
}

/** v2: `assetInfo`'s return shape. */
export interface AssetInfo {
  decimals: number;
  usd_price: number;
  symbol: string;
  known: boolean;
}

/**
 * v2 (application-design.md §3 "Asset registry"): the test and mainnet USDC known on
 * each chain, 6 decimals, usd_price 1. The mainnet entries are the same addresses
 * `corpus/rail-switch.yaml` already uses via `challenge.per_chain`.
 */
export const KNOWN_ASSETS: Record<Chain, KnownAsset[]> = {
  evm: [
    { address: CHAIN_DEFAULTS.evm.asset, symbol: "USDC", decimals: 6, usd_price: 1 },
    {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      symbol: "USDC",
      decimals: 6,
      usd_price: 1,
    },
  ],
  svm: [
    { address: CHAIN_DEFAULTS.svm.asset, symbol: "USDC", decimals: 6, usd_price: 1 },
    {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      symbol: "USDC",
      decimals: 6,
      usd_price: 1,
    },
  ],
};

/** evm addresses are compared case-insensitively (checksum vs lowercase); svm base58 is exact. */
function assetAddressEquals(chain: Chain, a: string, b: string): boolean {
  return chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * v2: resolves an asset's decimals/usd_price/symbol, per application-design.md §3
 * "Asset registry" - the one function every `amount_usd` in the harness goes through.
 * `scenarioAssets` (a scenario's own `assets:` list) is checked first, then
 * `KNOWN_ASSETS`; an unmatched asset is reported `known: false` with the harness's
 * blanket assumption (6 decimals, usd_price 1).
 */
export function assetInfo(chain: Chain, asset: string, scenarioAssets?: AssetSpec[]): AssetInfo {
  const scenarioMatch = scenarioAssets?.find(
    (a) => a.chain === chain && assetAddressEquals(chain, a.address, asset),
  );
  if (scenarioMatch) {
    return {
      decimals: scenarioMatch.decimals,
      usd_price: scenarioMatch.usd_price,
      symbol: scenarioMatch.symbol,
      known: true,
    };
  }
  const known = KNOWN_ASSETS[chain].find((a) => assetAddressEquals(chain, a.address, asset));
  if (known) {
    return {
      decimals: known.decimals,
      usd_price: known.usd_price,
      symbol: known.symbol,
      known: true,
    };
  }
  return { decimals: 6, usd_price: 1, symbol: asset, known: false };
}

/**
 * v2: the asset-aware USD value of an atomic amount, per application-design.md §3 -
 * `atomic / 10^decimals * usd_price` through `assetInfo()`.
 */
export function amountUsd(
  chain: Chain,
  asset: string,
  atomic: string,
  scenarioAssets?: AssetSpec[],
): number {
  const info = assetInfo(chain, asset, scenarioAssets);
  return atomicToUsd(atomic, info.decimals) * info.usd_price;
}
