import { describe, expect, it } from "vitest";
import { wilson95 } from "../src/wilson.js";

describe("wilson95 (ADR-010 §4: agent-track confidence interval)", () => {
  it("n=0 has no data, so the widest possible interval", () => {
    expect(wilson95(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it("5/5 passed: a narrower-than-naive interval, lo ≈ 0.566", () => {
    const { lo, hi } = wilson95(5, 5);
    expect(lo).toBeCloseTo(0.566, 2);
    expect(hi).toBe(1);
  });

  it("0/5 passed is the mirror image of 5/5", () => {
    const { lo, hi } = wilson95(0, 5);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(1 - 0.566, 2);
  });

  it("brackets the raw proportion and widens as n shrinks", () => {
    const small = wilson95(5, 10);
    const large = wilson95(50, 100);
    expect(small.lo).toBeLessThan(0.5);
    expect(small.hi).toBeGreaterThan(0.5);
    expect(large.lo).toBeLessThan(0.5);
    expect(large.hi).toBeGreaterThan(0.5);
    // Same point estimate (0.5), more data -> narrower interval.
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });

  it("stays within [0, 1] at the extremes", () => {
    const allPass = wilson95(20, 20);
    const allFail = wilson95(0, 20);
    expect(allPass.hi).toBeLessThanOrEqual(1);
    expect(allPass.lo).toBeGreaterThanOrEqual(0);
    expect(allFail.hi).toBeLessThanOrEqual(1);
    expect(allFail.lo).toBeGreaterThanOrEqual(0);
  });
});
