import { describe, expect, it } from "vitest";
import { atomicToUsd, CHAIN_DEFAULTS, usdToAtomic } from "../src/chains.js";

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
