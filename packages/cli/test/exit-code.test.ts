import type { Report } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import { computeExitCode } from "../src/run.js";

function reportWith(
  results: Array<{ severity: Report["scenarios"][number]["severity"]; pass: boolean }>,
): Report {
  return {
    schema: "x402-redteam/report@1",
    harness_version: "0.0.1",
    agent_id: "agent",
    guardrail_id: "none",
    seed: "seed",
    corpus_hash: "hash",
    summary: {
      runs: 0,
      passed: 0,
      failed: 0,
      pass_rate: 0,
      scenarios: 0,
      scenarios_passed: 0,
      unauthorized_usd: 0,
      wrong_recipient_usd: 0,
      max_overpay_ratio: 0,
      max_loop_count: 0,
    },
    by_category: {} as Report["by_category"],
    by_severity: {} as Report["by_severity"],
    scenarios: results.map((r, i) => ({
      id: `s${i}`,
      title: `s${i}`,
      category: "ghost_paywall",
      severity: r.severity,
      description: "",
      results: [
        {
          chain: "evm",
          pass: r.pass,
          pass_rate: r.pass ? 1 : 0,
          worst: {
            run_id: `s${i}`,
            pass: r.pass,
            violations: [],
            metrics: {
              unauthorized_usd: 0,
              wrong_recipient_usd: 0,
              overpay_ratio: 0,
              loop_count: 0,
              payments: 0,
            },
            exit_code: 0,
            timed_out: false,
          },
          attempts: [],
        },
      ],
    })),
    runs: [],
    timing: { total_ms: 0, runs: {} },
  };
}

describe("computeExitCode", () => {
  it("returns 0 when everything at/above the threshold passes", () => {
    const report = reportWith([
      { severity: "low", pass: false },
      { severity: "high", pass: true },
    ]);
    expect(computeExitCode(report, "medium")).toBe(0);
  });

  it("returns 1 when a scenario at/above the threshold fails", () => {
    const report = reportWith([{ severity: "high", pass: false }]);
    expect(computeExitCode(report, "medium")).toBe(1);
  });

  it("--fail-on low fails on any failure", () => {
    const report = reportWith([{ severity: "low", pass: false }]);
    expect(computeExitCode(report, "low")).toBe(1);
  });

  it("returns 0 for an empty report", () => {
    expect(computeExitCode(reportWith([]), "low")).toBe(0);
  });
});
