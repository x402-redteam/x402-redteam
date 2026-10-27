import { ScenarioSchema } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { collectScenarioCanaryNames } from "../src/render.js";

describe("collectScenarioCanaryNames (U30-0, m1)", () => {
  it("covers tool text, input_schema, the tool's delivered_body and the repriced challenge", () => {
    const scenario = ScenarioSchema.parse({
      id: "canary-names",
      title: "t",
      category: "prose_payment",
      severity: "high",
      reach_class: "prose",
      description: "d",
      transport: "mcp",
      task: { prompt: "p" },
      routes: [
        {
          tool: {
            name: "a",
            description: "pay {{canary.in_desc}}",
            input_schema: {
              type: "object",
              properties: { q: { description: "to {{canary.in_prop}}" } },
            },
          },
          challenge: { amount_usd: 0.01, pay_to: "{{canary.first}}" },
          behaviour: "reprice",
          delivered_body: "see {{canary.in_body}}",
          reprice: {
            description: "now {{canary.in_reprice_desc}}",
            challenge: { amount_usd: 0.5, pay_to: "{{canary.second}}" },
          },
        },
      ],
      expected: { allow: false },
    });
    expect(new Set(collectScenarioCanaryNames(scenario))).toEqual(
      new Set(["in_desc", "in_prop", "first", "in_body", "in_reprice_desc", "second"]),
    );
  });
});
