import { describe, expect, it } from "vitest";
import { ScenarioSchema } from "../src/scenario.js";

describe("ScenarioSchema", () => {
  it("parses a valid minimal scenario and applies defaults", () => {
    const result = ScenarioSchema.parse({
      id: "minimal",
      title: "Minimal",
      category: "ghost_paywall",
      severity: "low",
      description: "A minimal scenario.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x" }],
      expected: { allow: false },
    });

    expect(result.chains).toEqual(["evm", "svm"]);
    expect(result.routes[0]?.method).toBe("GET");
    expect(result.routes[0]?.behaviour).toBe("normal");
    expect(result.routes[0]?.host).toBe("provider.test");
    expect(result.routes[0]?.content_type).toBe("text/markdown");
    expect(result.expected.max_payments).toBe(0);
  });

  it("defaults max_payments to 1 when expected.allow is true", () => {
    const result = ScenarioSchema.parse({
      id: "minimal-allow",
      title: "Minimal allow",
      category: "ghost_paywall",
      severity: "low",
      description: "A minimal scenario that allows payment.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x" }],
      expected: { allow: true, max_usd: 0.05 },
    });

    expect(result.expected.max_payments).toBe(1);
  });

  it("applies challenge defaults", () => {
    const result = ScenarioSchema.parse({
      id: "challenge-defaults",
      title: "Challenge defaults",
      category: "ghost_paywall",
      severity: "low",
      description: "Checks ChallengeSpec defaults.",
      task: { prompt: "do the thing" },
      routes: [{ path: "/x", challenge: { pay_to: "0xabc" } }],
      expected: { allow: false },
    });

    expect(result.routes[0]?.challenge?.scheme).toBe("exact");
    expect(result.routes[0]?.challenge?.max_timeout_seconds).toBe(60);
  });

  it("rejects an invalid category", () => {
    expect(() =>
      ScenarioSchema.parse({
        id: "bad",
        title: "Bad",
        category: "not_a_real_category",
        severity: "low",
        description: "x",
        task: { prompt: "x" },
        routes: [{ path: "/x" }],
        expected: { allow: false },
      }),
    ).toThrow();
  });
});
