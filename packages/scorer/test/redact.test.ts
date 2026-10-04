import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { scoreSuite } from "../src/score-suite.js";
import type { RunConfig } from "../src/types.js";
import { baseConfig, makePayment, makeRun, makeScenario } from "./helpers.js";

const CONFIG: RunConfig = baseConfig({ track: "guardrail", driver: "driver@1" });

const HELD_OUT_SCENARIO_ID = "held-out-scenario-xyz";
const HELD_OUT_TITLE = "Secret held-out title";
const HELD_OUT_DESCRIPTION = "This description mentions weather-report.test and a canary.";
const HELD_OUT_HOST = "weather-report.test";
const HELD_OUT_VIOLATION_MESSAGE = `payment sent to canary at ${HELD_OUT_HOST}`;

function buildReportWithViolation() {
  const scenario = makeScenario({
    id: HELD_OUT_SCENARIO_ID,
    title: HELD_OUT_TITLE,
    description: HELD_OUT_DESCRIPTION,
    expected: { allow: false },
  });
  const payment = makePayment({
    amount_usd: 0.02,
    instruction_source: "prose",
    to: "0x9999999999999999999999999999999999999999",
  });
  const run = makeRun({ scenario_id: scenario.id, payments: [payment] });
  return scoreSuite({
    scenarios: [scenario],
    runs: [run],
    ctx: { seed: CONFIG.seed },
    meta: { harness_version: "0.0.1", agent_id: "agent", guardrail_id: "g", config: CONFIG },
  });
}

describe("redact (ADR-011, security review CRITICAL-2)", () => {
  it("drops runs[] entirely", () => {
    const report = buildReportWithViolation();
    const redacted = redact(report);
    expect("runs" in redacted).toBe(false);
  });

  it("drops scenarios[] entirely - not blanked, absent", () => {
    const report = buildReportWithViolation();
    expect(report.scenarios.length).toBeGreaterThan(0);
    const redacted = redact(report);
    expect("scenarios" in redacted).toBe(false);
  });

  it("drops the top-level seed field entirely", () => {
    const report = buildReportWithViolation();
    const redacted = redact(report);
    expect("seed" in redacted).toBe(false);
  });

  it("the serialized redacted report never contains the held-out scenario id, title, description, host or violation message", () => {
    const report = buildReportWithViolation();
    // Sanity: these strings really are present in the unredacted report first.
    const fullJson = JSON.stringify(report);
    expect(fullJson).toContain(HELD_OUT_SCENARIO_ID);
    expect(fullJson).toContain(HELD_OUT_TITLE);
    expect(fullJson).toContain(HELD_OUT_HOST);

    const redactedJson = JSON.stringify(redact(report));
    expect(redactedJson).not.toContain(HELD_OUT_SCENARIO_ID);
    expect(redactedJson).not.toContain(HELD_OUT_TITLE);
    expect(redactedJson).not.toContain(HELD_OUT_DESCRIPTION);
    expect(redactedJson).not.toContain(HELD_OUT_HOST);
    expect(redactedJson).not.toContain(HELD_OUT_VIOLATION_MESSAGE);
  });

  it("leaves summary, by_category, by_severity, by_reach_class and config byte-identical", () => {
    const report = buildReportWithViolation();
    const redacted = redact(report);
    expect(redacted.summary).toEqual(report.summary);
    expect(redacted.by_category).toEqual(report.by_category);
    expect(redacted.by_severity).toEqual(report.by_severity);
    expect(redacted.by_reach_class).toEqual(report.by_reach_class);
    expect(redacted.config).toEqual(report.config);
    expect(redacted.corpus_hash).toBe(report.corpus_hash);
  });

  it("schema becomes x402-redteam/report@3-redacted", () => {
    const report = buildReportWithViolation();
    expect(redact(report).schema).toBe("x402-redteam/report@3-redacted");
  });

  it("keeps only the documented fields (summary, by_*, config, hashes, identity) - nothing else", () => {
    const report = buildReportWithViolation();
    const redacted = redact(report);
    expect(Object.keys(redacted).sort()).toEqual(
      [
        "agent_id",
        "by_category",
        "by_reach_class",
        "by_severity",
        "config",
        "corpus_hash",
        "guardrail_id",
        "harness_version",
        "schema",
        "summary",
      ].sort(),
    );
  });
});
