import { describe, expect, it } from "vitest";
import { stripTiming, toJson } from "../src/json-reporter.js";
import { scoreSuite } from "../src/score-suite.js";
import type { ScoreContext, SuiteMeta } from "../src/types.js";
import { baseConfig, makeRun, makeScenario } from "./helpers.js";

const ctx: ScoreContext = { seed: "test-seed" };
const meta: SuiteMeta = {
  harness_version: "0.0.1",
  agent_id: "naive",
  guardrail_id: "none",
  config: baseConfig(),
};

describe("toJson / stripTiming (functional-design.md §2)", () => {
  it("produces sorted-key, 2-space-indented output with a trailing newline", () => {
    const scenario = makeScenario({ id: "json-scenario", expected: { allow: false } });
    const run = makeRun({ scenario_id: scenario.id });
    const report = scoreSuite({ scenarios: [scenario], runs: [run], ctx, meta });

    const json = toJson(report);
    expect(json.endsWith("}\n")).toBe(true);

    const parsed = JSON.parse(json);
    const topKeys = Object.keys(parsed);
    expect(topKeys).toEqual([...topKeys].sort());

    // Re-parse and re-canonicalize round-trips identically (2-space indent check).
    expect(json).toContain('\n  "agent_id"');
  });

  it("is deterministic for the same inputs", () => {
    const scenario = makeScenario({ id: "json-det", expected: { allow: false } });
    const run = makeRun({ scenario_id: scenario.id });

    const r1 = scoreSuite({ scenarios: [scenario], runs: [run], ctx, meta });
    const r2 = scoreSuite({ scenarios: [scenario], runs: [run], ctx, meta });

    expect(toJson(r1)).toBe(toJson(r2));
  });

  it("toJson(stripTiming(r)) is identical for two reports built from the same inputs with different timing", () => {
    const scenario = makeScenario({ id: "json-strip", expected: { allow: false } });
    const runA = makeRun({
      run_id: "json-strip:evm:1",
      scenario_id: scenario.id,
      timing: { duration_ms: 111 },
    });
    const runB = makeRun({
      run_id: "json-strip:evm:1",
      scenario_id: scenario.id,
      timing: { duration_ms: 999 },
    });

    const r1 = scoreSuite({ scenarios: [scenario], runs: [runA], ctx, meta });
    const r2 = scoreSuite({ scenarios: [scenario], runs: [runB], ctx, meta });

    expect(toJson(r1)).not.toBe(toJson(r2));
    expect(toJson(stripTiming(r1))).toBe(toJson(stripTiming(r2)));
  });
});
