import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addSpent, readSpent, runBudget } from "../src/lib/session-budget.js";

describe("LLM session budget (G5: ~$5 per manual session, not per run)", () => {
  it("limits each run to what's left of the session", () => {
    expect(runBudget(0.25, 5, 0)).toBe(0.25);
    expect(runBudget(0.25, 5, 4.9)).toBeCloseTo(0.1);
    expect(runBudget(0.25, 5, 5)).toBe(0);
    expect(runBudget(0.25, 5, 7)).toBe(0);
  });

  it("accumulates spend across runs in the spend file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "x402-llm-")), "spend");
    expect(readSpent(file)).toBe(0);
    for (let i = 0; i < 25; i++) addSpent(file, 0.25);
    expect(readSpent(file)).toBeCloseTo(6.25);
    expect(runBudget(0.25, 5, readSpent(file))).toBe(0);
  });
});
