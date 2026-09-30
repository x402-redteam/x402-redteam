import type { Report, RunConfig } from "@x402-redteam/scorer";
import { describe, expect, it } from "vitest";
import { computeExitCode } from "../src/run.js";

const CONFIG: RunConfig = {
  seed: "seed",
  chains: ["evm", "svm"],
  repeat: 1,
  timeout_s: 60,
  fail_on: "low",
  scenario_filter: null,
  controls_included: true,
};

function reportWith(
  results: Array<{ severity: Report["scenarios"][number]["severity"]; pass: boolean }>,
  opts: { valid?: boolean | null } = {},
): Report {
  return {
    schema: "x402-redteam/report@2",
    harness_version: "0.0.1",
    agent_id: "agent",
    guardrail_id: "none",
    seed: "seed",
    corpus_hash: "hash",
    config: CONFIG,
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
      valid: opts.valid ?? true,
      controls: { runs: 0, passed: 0 },
      utility: 0,
      agent_errors: 0,
      safety_score: 100,
      notional_unauthorized_usd: 0,
      capture_layers: { header: 0, shim: 0, rpc: 0 },
    },
    by_category: {} as Report["by_category"],
    by_severity: {} as Report["by_severity"],
    scenarios: results.map((r, i) => ({
      id: `s${i}`,
      title: `s${i}`,
      category: "ghost_paywall",
      severity: r.severity,
      description: "",
      kind: "attack",
      results: [
        {
          chain: "evm",
          pass: r.pass,
          pass_rate: r.pass ? 1 : 0,
          worst: {
            run_id: `s${i}`,
            status: r.pass ? "pass" : "fail",
            agent_ok: true,
            kind: "attack",
            violations: [],
            metrics: {
              unauthorized_usd: 0,
              wrong_recipient_usd: 0,
              overpay_ratio: 0,
              loop_count: 0,
              payments: 0,
              notional_unauthorized_usd: 0,
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

  it("returns 2 when summary.valid is false, regardless of attack results", () => {
    const report = reportWith([{ severity: "critical", pass: true }], { valid: false });
    expect(computeExitCode(report, "low")).toBe(2);
  });

  it("does not return 2 when summary.valid is null (--skip-controls)", () => {
    const report = reportWith([{ severity: "low", pass: true }], { valid: null });
    expect(computeExitCode(report, "low")).toBe(0);
  });

  it("code review fix 6: summary.valid null with a failing attack still returns 1, not 0 or 2", () => {
    const report = reportWith([{ severity: "high", pass: false }], { valid: null });
    expect(computeExitCode(report, "low")).toBe(1);
  });

  it("ignores control-kind scenarios when applying --fail-on", () => {
    const report = reportWith([{ severity: "critical", pass: true }]);
    report.scenarios.push({
      id: "a-control",
      title: "a control",
      category: "control",
      severity: "high",
      description: "",
      kind: "control",
      results: [
        {
          chain: "evm",
          pass: false,
          pass_rate: 0,
          worst: {
            run_id: "a-control",
            status: "fail",
            agent_ok: true,
            kind: "control",
            violations: [],
            metrics: {
              unauthorized_usd: 0,
              wrong_recipient_usd: 0,
              overpay_ratio: 0,
              loop_count: 0,
              payments: 0,
              notional_unauthorized_usd: 0,
            },
            exit_code: 0,
            timed_out: false,
          },
          attempts: [],
        },
      ],
    });
    expect(computeExitCode(report, "low")).toBe(0);
  });
});
