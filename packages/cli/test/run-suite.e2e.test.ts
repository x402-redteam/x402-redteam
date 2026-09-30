import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chain } from "@x402-redteam/schema";
import type { Report } from "@x402-redteam/scorer";
import { stripTiming, toJson, toMarkdown } from "@x402-redteam/scorer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";
import { agentCmd } from "./helpers/agent-cmd.js";

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
// The real corpus (including corpus/controls/**, owned by U9 Part B), for the ADR-009 /
// ADR-015 acceptance E2E in U9 Part B functional-design.md §B4, which needs real controls
// to exercise `summary.valid`/`utility`/`safety_score`.
const REAL_CORPUS = new URL("../../../corpus", import.meta.url).pathname;
const SEED = "x402-redteam-v1";

function baseOptions(outDir: string, corpus: string = FIXTURE_CORPUS) {
  return {
    corpus,
    chains: ["evm", "svm"] as Chain[],
    repeat: 1,
    timeoutMs: 30_000,
    seed: SEED,
    outDir,
    failOn: "low" as const,
  };
}

/**
 * The real @x402/evm client embeds a fresh random EIP-3009 nonce per signature (see
 * packages/adversary/test/determinism.test.ts's own note: "the real EVM/SVM clients embed
 * wall-clock timestamps and random nonces, so two runs driven through them are never
 * byte-identical"), so `dedupe_key`/`raw` (which encodes the nonce/signature) legitimately
 * differ between two independent naive runs even though every *decision* the harness makes
 * from them - violations, pass/fail, metrics, sequencing, attribution - is deterministic.
 * This redacts exactly those two randomness-bearing fields before comparing, so the test
 * verifies the harness's own determinism rather than the signing library's.
 *
 * (U10, ADR-013 note: `authorization_seconds` is wall-clock-tainted for the same reason -
 * verified in source, @x402/evm@2.28.0's exact-EVM client sets `validAfter: "0"` but
 * `validBefore: now + maxTimeoutSeconds` - but `scoreSuite` already strips it from
 * report.json's payments for exactly this reason, same as `raw`/`dedupe_key`, so no redaction
 * is needed here.)
 */
function redactSigningRandomness(report: Report): Report {
  return {
    ...report,
    runs: report.runs.map((run) => ({
      ...run,
      payments: run.payments.map((p) => ({ ...p, dedupe_key: "REDACTED", raw: "REDACTED" })),
    })),
  };
}

describe("runSuite against the U5 fixture corpus", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-e2e-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("naive fails every hostile scenario on both chains, with a prose payment recorded", async () => {
    const start = performance.now();
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      agentCmd: agentCmd("naive"),
      agentId: "naive",
      guardrailId: "none",
      // This U5 fixture corpus predates ADR-009 and has no corpus/controls/**; without
      // --skip-controls, controls_included: true + zero control runs is itself invalid
      // (code review fix 1) and would always return exit 2 here, which isn't what this
      // test is about (attack-scenario behavior for the reference agents).
      skipControls: true,
    });
    const wallClockMs = performance.now() - start;
    console.log(`naive: full fixture corpus took ${Math.round(wallClockMs)}ms`);

    expect(wallClockMs).toBeLessThan(5 * 60_000);
    expect(exitCode).toBe(1);
    expect(report.scenarios.length).toBe(3);

    for (const scenario of report.scenarios) {
      for (const result of scenario.results) {
        expect(result.pass, `${scenario.id} [${result.chain}] should fail for naive`).toBe(false);
        expect(result.worst.metrics.unauthorized_usd).toBeGreaterThan(0);
      }
    }

    const proseScenario = report.scenarios.find((s) => s.id === "prose-lure");
    expect(proseScenario).toBeDefined();
    const proseRun = report.runs.find(
      (r) =>
        r.scenario_id === "prose-lure" && r.payments.some((p) => p.instruction_source === "prose"),
    );
    expect(proseRun).toBeDefined();
  });

  it("guarded passes every scenario on both chains", async () => {
    const start = performance.now();
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      agentCmd: agentCmd("guarded"),
      agentId: "guarded",
      guardrailId: "policy-v1",
      // See the naive test above: this fixture corpus has no corpus/controls/**.
      skipControls: true,
    });
    const wallClockMs = performance.now() - start;
    console.log(`guarded: full fixture corpus took ${Math.round(wallClockMs)}ms`);

    expect(wallClockMs).toBeLessThan(5 * 60_000);
    expect(exitCode).toBe(0);
    expect(report.scenarios.length).toBe(3);

    for (const scenario of report.scenarios) {
      for (const result of scenario.results) {
        expect(result.pass, `${scenario.id} [${result.chain}] should pass for guarded`).toBe(true);
      }
    }
  });

  it("running naive twice gives identical reports modulo timing", async () => {
    const outDirA = mkdtempSync(join(tmpdir(), "x402-redteam-det-a-"));
    const outDirB = mkdtempSync(join(tmpdir(), "x402-redteam-det-b-"));
    try {
      const [a, b] = await Promise.all([
        runSuite({
          ...baseOptions(outDirA),
          agentCmd: agentCmd("naive"),
          agentId: "naive",
          guardrailId: "none",
        }),
        runSuite({
          ...baseOptions(outDirB),
          agentCmd: agentCmd("naive"),
          agentId: "naive",
          guardrailId: "none",
        }),
      ]);
      expect(toJson(redactSigningRandomness(stripTiming(a.report)))).toBe(
        toJson(redactSigningRandomness(stripTiming(b.report))),
      );
    } finally {
      rmSync(outDirA, { recursive: true, force: true });
      rmSync(outDirB, { recursive: true, force: true });
    }
  });
});

/**
 * U9 Part B functional-design.md §B4 acceptance E2E, against the real corpus (the fixture
 * corpus above has no `corpus/controls/**`, so it can't exercise ADR-009's controls / the
 * ADR-015 exposure cap and safety score).
 */
describe("runSuite against the real corpus (ADR-009 controls, ADR-015 exposure cap/safety score)", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-real-e2e-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('a no-op agent ("true") is invalid: exit 2, summary.valid === false, utility === 0', async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: "true",
      agentId: "noop",
      guardrailId: "none",
    });

    expect(exitCode).toBe(2);
    expect(report.summary.valid).toBe(false);
    expect(report.summary.utility).toBe(0);
  }, 60_000);

  it('a crashing agent ("exit 3") is invalid: exit 2', async () => {
    const { exitCode, report } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: "exit 3",
      agentId: "crash",
      guardrailId: "none",
    });

    expect(exitCode).toBe(2);
    expect(report.summary.valid).toBe(false);
  }, 60_000);

  it("naive: exit 1, valid, every control passed, unauthorized_usd capped, notional uncapped", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: agentCmd("naive"),
      agentId: "naive",
      guardrailId: "none",
    });

    expect(exitCode).toBe(1);
    expect(report.summary.valid).toBe(true);
    expect(report.summary.controls.passed).toBe(report.summary.controls.runs);
    expect(report.summary.controls.runs).toBeGreaterThan(0);
    expect(report.summary.utility).toBe(1);
    expect(report.summary.unauthorized_usd).toBeLessThanOrEqual(100 * report.summary.runs);
    expect(report.summary.notional_unauthorized_usd).toBeGreaterThanOrEqual(1e12);
  }, 120_000);

  it("guarded: exit 0, valid, every control passed, safety_score 100", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: agentCmd("guarded"),
      agentId: "guarded",
      guardrailId: "policy-v1",
    });

    expect(exitCode).toBe(0);
    expect(report.summary.valid).toBe(true);
    expect(report.summary.controls.passed).toBe(report.summary.controls.runs);
    expect(report.summary.controls.runs).toBeGreaterThan(0);
    expect(report.summary.safety_score).toBe(100);
  }, 120_000);

  it("code review fix 6: controls are retained under a --scenario filter", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: agentCmd("guarded"),
      agentId: "guarded",
      guardrailId: "policy-v1",
      scenarioIds: ["price-bait"],
    });

    const attackIds = report.scenarios.filter((s) => s.kind === "attack").map((s) => s.id);
    const controlIds = report.scenarios.filter((s) => s.kind === "control").map((s) => s.id);
    expect(attackIds).toEqual(["price-bait"]);
    expect(controlIds.length).toBeGreaterThan(0);
    expect(report.summary.controls.runs).toBeGreaterThan(0);
    expect(report.summary.valid).toBe(true);
    expect(exitCode).toBe(0);
  }, 60_000);

  it("code review fix 6: --skip-controls gives summary.valid === null, a WARNING banner, and an exit code driven only by attacks", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir, REAL_CORPUS),
      agentCmd: agentCmd("naive"),
      agentId: "naive",
      guardrailId: "none",
      scenarioIds: ["ghost-paywall"],
      skipControls: true,
    });

    expect(report.scenarios.every((s) => s.kind !== "control")).toBe(true);
    expect(report.summary.valid).toBeNull();
    expect(toMarkdown(report)).toContain("> **WARNING**");
    // naive fails ghost-paywall regardless of controls being skipped.
    expect(exitCode).toBe(1);
  }, 60_000);
});
