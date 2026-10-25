import { describe, expect, it } from "vitest";
import { stripTiming } from "../src/json-reporter.js";
import { toMarkdown } from "../src/markdown-reporter.js";
import { toSarif } from "../src/sarif-reporter.js";
import { scoreSuite } from "../src/score-suite.js";
import type { ScoreContext, SuiteMeta } from "../src/types.js";
import { baseConfig, makePayment, makeRun, makeScenario } from "./helpers.js";

const ctx: ScoreContext = { seed: "test-seed" };
const meta: SuiteMeta = {
  harness_version: "1.0.0",
  agent_id: "a",
  guardrail_id: "none",
  config: baseConfig(),
};

function report(transport: "mcp" | undefined) {
  const scenario = makeScenario({
    id: "t-fail",
    category: "ghost_paywall",
    severity: "high",
    title: "T",
    description: "d",
    expected: { allow: false },
  });
  const run = makeRun({
    run_id: "t-fail:evm:1",
    scenario_id: scenario.id,
    timing: { duration_ms: 1 },
    payments: [makePayment({ seq: 1, amount_usd: 0.25, ...(transport ? { transport } : {}) })],
  });
  return scoreSuite({ scenarios: [scenario], runs: [run], ctx, meta });
}

describe("MCP transport in reports (U30-1, M4)", () => {
  it("summary.transports is present only for MCP legs", () => {
    expect(report("mcp").summary.transports).toEqual({ mcp: 1 });
    expect("transports" in report(undefined).summary).toBe(false);
  });

  it("Markdown and SARIF print header (mcp) for MCP legs and plain header otherwise", () => {
    expect(toMarkdown(report("mcp"))).toContain("| header (mcp) | header (mcp) |");
    expect(toMarkdown(report(undefined))).not.toContain("(mcp)");
    expect(toSarif(report("mcp"))).toContain("(header (mcp))");
    expect(toSarif(report(undefined))).not.toContain("(mcp)");
  });

  it("an HTTP report has no transport anywhere in its JSON", () => {
    expect(JSON.stringify(stripTiming(report(undefined)))).not.toContain("transport");
  });
});
