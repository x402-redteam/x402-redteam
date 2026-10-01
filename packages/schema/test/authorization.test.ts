import { describe, expect, it } from "vitest";
import { maxAuthorizationSeconds } from "../src/authorization.js";
import { ScenarioSchema } from "../src/scenario.js";

function scenario(maxAuthorizationSecondsValue: number | undefined) {
  return ScenarioSchema.parse({
    id: "s",
    title: "S",
    category: "authorization_lifetime",
    severity: "medium",
    reach_class: "challenge",
    description: "d",
    task: { prompt: "do the thing" },
    routes: [{ path: "/x", surface: true }],
    expected: {
      allow: true,
      max_usd: 1,
      ...(maxAuthorizationSecondsValue !== undefined
        ? { max_authorization_seconds: maxAuthorizationSecondsValue }
        : {}),
    },
  });
}

describe("maxAuthorizationSeconds", () => {
  it("returns expected.max_authorization_seconds when set", () => {
    expect(maxAuthorizationSeconds(scenario(900), "evm")).toBe(900);
  });

  it("returns undefined when the scenario never set it", () => {
    expect(maxAuthorizationSeconds(scenario(undefined), "evm")).toBeUndefined();
  });

  it("is chain-agnostic today (authorization_lifetime is evm-only, no svm equivalent yet)", () => {
    expect(maxAuthorizationSeconds(scenario(900), "svm")).toBe(900);
  });
});
