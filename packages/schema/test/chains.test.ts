import { describe, expect, it } from "vitest";
import {
  amountUsd,
  assetInfo,
  atomicToUsd,
  CHAIN_DEFAULTS,
  KNOWN_ASSETS,
  NATIVE_ASSET,
  usdToAtomic,
} from "../src/chains.js";

describe("usdToAtomic", () => {
  it("converts exact cent/micro amounts without float drift", () => {
    expect(usdToAtomic(0.001, 6)).toBe("1000");
    expect(usdToAtomic(1, 6)).toBe("1000000");
    expect(usdToAtomic(0.1 + 0.2, 6)).toBe("300000");
  });

  it("round-trips through atomicToUsd", () => {
    for (const usd of [0, 0.001, 0.1, 1, 1.5, 123.456789]) {
      const atomic = usdToAtomic(usd, 6);
      expect(atomicToUsd(atomic, 6)).toBeCloseTo(usd, 6);
    }
  });

  it("rejects non-finite input", () => {
    expect(() => usdToAtomic(Number.NaN, 6)).toThrow();
    expect(() => usdToAtomic(Number.POSITIVE_INFINITY, 6)).toThrow();
  });
});

describe("CHAIN_DEFAULTS", () => {
  it("matches application-design.md §3 exactly", () => {
    expect(CHAIN_DEFAULTS.evm).toEqual({
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      extra: { name: "USDC", version: "2" },
    });
    expect(CHAIN_DEFAULTS.svm).toEqual({
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      decimals: 6,
      extra: {},
    });
  });
});

// v2 (Bolt 5, U9 Part A functional-design.md §A1 "Asset registry").
describe("KNOWN_ASSETS / assetInfo (v2)", () => {
  it("has the test and mainnet USDC entries on both chains, 6 decimals, usd_price 1", () => {
    const usdc = [...KNOWN_ASSETS.evm, ...KNOWN_ASSETS.svm].filter(
      (a) => a.address !== NATIVE_ASSET,
    );
    expect(usdc).toHaveLength(4);
    for (const entry of usdc) {
      expect(entry.decimals).toBe(6);
      expect(entry.usd_price).toBe(1);
      expect(entry.symbol).toBe("USDC");
    }
  });

  it("resolves the default test USDC on each chain to {decimals: 6, usd_price: 1, known: true}", () => {
    expect(assetInfo("evm", CHAIN_DEFAULTS.evm.asset)).toEqual({
      decimals: 6,
      usd_price: 1,
      symbol: "USDC",
      known: true,
    });
    expect(assetInfo("svm", CHAIN_DEFAULTS.svm.asset)).toEqual({
      decimals: 6,
      usd_price: 1,
      symbol: "USDC",
      known: true,
    });
  });

  it("matches evm addresses case-insensitively", () => {
    const upper = CHAIN_DEFAULTS.evm.asset.toUpperCase().replace("0X", "0x");
    expect(assetInfo("evm", upper).known).toBe(true);
  });

  it("matches svm addresses case-sensitively (an svm case change is unknown)", () => {
    const flipped = CHAIN_DEFAULTS.svm.asset.toLowerCase();
    expect(flipped).not.toBe(CHAIN_DEFAULTS.svm.asset);
    expect(assetInfo("svm", flipped).known).toBe(false);
  });

  it("resolves the rail-switch mainnet USDC addresses as known", () => {
    expect(assetInfo("evm", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").known).toBe(true);
    expect(assetInfo("svm", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").known).toBe(true);
  });

  it("falls back to {decimals: 6, usd_price: 1, known: false} for an unknown asset", () => {
    const result = assetInfo("evm", "0xdeadbeef00000000000000000000000000dead");
    expect(result.decimals).toBe(6);
    expect(result.usd_price).toBe(1);
    expect(result.known).toBe(false);
  });

  it("prefers a scenario-declared asset over KNOWN_ASSETS", () => {
    const result = assetInfo("evm", "0xWETH", [
      { chain: "evm", address: "0xWETH", symbol: "WETH", decimals: 18, usd_price: 3000 },
    ]);
    expect(result).toEqual({ decimals: 18, usd_price: 3000, symbol: "WETH", known: true });
  });

  it("ignores a scenario asset declared for a different chain", () => {
    const result = assetInfo("evm", "0xWETH", [
      { chain: "svm", address: "0xWETH", symbol: "WETH", decimals: 18, usd_price: 3000 },
    ]);
    expect(result.known).toBe(false);
  });
});

describe("amountUsd (v2)", () => {
  it("computes atomic / 10^decimals * usd_price through assetInfo", () => {
    expect(amountUsd("evm", CHAIN_DEFAULTS.evm.asset, "10000")).toBeCloseTo(0.01, 6);
  });

  it("scales by a scenario-declared asset's usd_price and decimals", () => {
    const scenarioAssets = [
      { chain: "evm" as const, address: "0xWETH", symbol: "WETH", decimals: 18, usd_price: 3000 },
    ];
    // 0.01 WETH (18 decimals) at $3000/WETH = $30.
    expect(amountUsd("evm", "0xWETH", "10000000000000000", scenarioAssets)).toBeCloseTo(30, 6);
  });
});

describe("native asset", () => {
  it("values 1 ETH and 1 SOL at their modelled prices", () => {
    expect(amountUsd("evm", NATIVE_ASSET, "1000000000000000000")).toBe(2500);
    expect(amountUsd("svm", NATIVE_ASSET, "1000000000")).toBe(150);
    expect(assetInfo("evm", NATIVE_ASSET).known).toBe(true);
  });
});
