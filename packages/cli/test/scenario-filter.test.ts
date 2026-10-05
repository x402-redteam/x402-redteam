import { describe, expect, it } from "vitest";
import { assertScenarioFilterKnown } from "../src/run.js";

const ALL = [{ id: "ghost-paywall" }, { id: "price-bait" }, { id: "replay" }];

describe("assertScenarioFilterKnown (--scenario validation)", () => {
  it("does nothing when no filter is given", () => {
    expect(() => assertScenarioFilterKnown(ALL, undefined)).not.toThrow();
  });

  it("does nothing when every requested id matches a loaded scenario", () => {
    expect(() => assertScenarioFilterKnown(ALL, ["price-bait", "replay"])).not.toThrow();
  });

  it("does nothing for an empty filter list", () => {
    expect(() => assertScenarioFilterKnown(ALL, [])).not.toThrow();
  });

  it("throws naming a single unknown id", () => {
    expect(() => assertScenarioFilterKnown(ALL, ["no-such-scenario"])).toThrow(
      /unknown scenario id\(s\).*no-such-scenario/,
    );
  });

  it("throws naming only the ids that don't match, sorted and de-duplicated, leaving valid ids out", () => {
    try {
      assertScenarioFilterKnown(ALL, ["zebra-bad", "price-bait", "zebra-bad", "alpha-bad"]);
      throw new Error("expected assertScenarioFilterKnown to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("alpha-bad, zebra-bad");
      expect(message).not.toContain("price-bait");
    }
  });
});
