import { describe, expect, it } from "vitest";
import { formatUsd, round1 } from "../src/round.js";

describe("round1", () => {
  it("rounds to 1 decimal place (ADR-015 #3 safety_score)", () => {
    expect(round1(12.5)).toBe(12.5);
    expect(round1(100 * (1 - 7 / 8))).toBe(12.5);
    expect(round1(33.333333)).toBe(33.3);
    expect(round1(100)).toBe(100);
  });
});

describe("formatUsd", () => {
  it("keeps sub-cent amounts visible", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.001)).toBe("$0.001");
    expect(formatUsd(0.000123)).toBe("$0.000123");
    expect(formatUsd(3)).toBe("$3.00");
  });

  it("adds thousands separators at $1,000 and above, with exactly 2 decimals", () => {
    expect(formatUsd(1000)).toBe("$1,000.00");
    expect(formatUsd(999.99)).toBe("$999.99");
    expect(formatUsd(1000.001)).toBe("$1,000.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(1000000)).toBe("$1,000,000.00");
    expect(formatUsd(4000000000013.24)).toBe("$4,000,000,000,013.24");
  });

  it("rounds sub-cent noise away once the amount is ≥ $1,000", () => {
    expect(formatUsd(1000.000001)).toBe("$1,000.00");
    expect(formatUsd(1234567.891234)).toBe("$1,234,567.89");
  });
});
