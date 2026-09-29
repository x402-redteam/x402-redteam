import { describe, expect, it } from "vitest";
import { formatUsd } from "../src/round.js";

describe("formatUsd", () => {
  it("keeps sub-cent amounts visible", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.001)).toBe("$0.001");
    expect(formatUsd(0.000123)).toBe("$0.000123");
    expect(formatUsd(3)).toBe("$3.00");
  });
});
