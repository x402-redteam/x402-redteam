import { describe, expect, it } from "vitest";
import { challengeAmountUsd } from "../src/lib/amount-check.js";

describe("guarded agent amount gate (U29-0)", () => {
  it("passes a digit amount through", () => {
    expect(challengeAmountUsd("10000", 6)).toEqual({ usd: 0.01 });
  });
  it.each(["1.5", "0x10", " 1", "+5", "1e6", ""])("denies the unparseable amount %j", (amount) => {
    const result = challengeAmountUsd(amount, 6);
    expect("deny" in result).toBe(true);
  });
});
