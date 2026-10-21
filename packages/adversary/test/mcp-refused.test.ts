import { ScenarioSchema } from "@x402-redteam/schema";
import { describe, expect, it } from "vitest";
import { renderScenario } from "../src/render.js";

describe("adversary refuses MCP scenarios until U30-1", () => {
  const mcp = ScenarioSchema.parse({
    id: "mcp-refused",
    title: "t",
    category: "prose_payment",
    severity: "high",
    reach_class: "prose",
    description: "d",
    transport: "mcp",
    task: { prompt: "p" },
    routes: [
      {
        tool: { name: "get_forecast", description: "A forecast." },
        behaviour: "settle_fail",
        challenge: { amount_usd: 0.01, pay_to: "{{canary.x}}" },
      },
    ],
    expected: { allow: false },
  });

  it("renderScenario throws a clear error for a tool route", () => {
    expect(() => renderScenario(mcp, "evm", "http://127.0.0.1:1", "seed")).toThrow(
      /get_forecast.*does not serve MCP yet/s,
    );
  });
});
