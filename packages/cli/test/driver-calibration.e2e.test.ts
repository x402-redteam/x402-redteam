/**
 * U18 functional-design.md §4 "Orchestrator only": the full corpus x 5 example
 * guardrails, through the real standard driver (`packages/driver`). Far too slow for a
 * developer loop (5 full-corpus runs) - the orchestrator runs this, never the unit's own
 * `pnpm test`. The developer-level probes this unit is actually responsible for running
 * itself live in `driver-probe.test.ts` (one scenario, one guardrail, one chain each).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chain } from "@x402-redteam/schema";
import type { Report } from "@x402-redteam/scorer";
import { stripTiming, toJson } from "@x402-redteam/scorer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentCommand } from "../src/guardrail-track.js";
import { runSuite } from "../src/run.js";
import { guardrailCmd } from "./helpers/agent-cmd.js";

const REAL_CORPUS = new URL("../../../corpus", import.meta.url).pathname;
const SEED = "x402-redteam-v1";

function baseOptions(outDir: string) {
  return {
    corpus: REAL_CORPUS,
    chains: ["evm", "svm"] as Chain[],
    repeat: 1,
    timeoutMs: 60_000,
    seed: SEED,
    outDir,
    failOn: "low" as const,
    harnessCommit: "test-harness-commit",
    agentId: "driver",
    guardrailId: "driver-calibration",
  };
}

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "x402-driver-calibration-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

async function runGuardrail(script: Parameters<typeof guardrailCmd>[0], dir: string) {
  const resolved = resolveAgentCommand({ guardrail: guardrailCmd(script) });
  return runSuite({ ...resolved, ...baseOptions(dir) });
}

describe("driver calibration against the real corpus (ADR-010 §3)", () => {
  it("allow-all fails every attack scenario x chain and passes every control", async () => {
    const { report } = await runGuardrail("allow-all", join(outDir, "allow-all"));
    for (const scenario of report.scenarios) {
      for (const result of scenario.results) {
        if (scenario.kind === "control") {
          expect(result.pass, `control ${scenario.id}/${result.chain} should pass`).toBe(true);
        } else {
          expect(
            result.pass,
            `attack ${scenario.id}/${result.chain} should fail (unreachable otherwise)`,
          ).toBe(false);
        }
      }
    }
  });

  it("deny-all passes every attack, fails every control, and is INVALID (exit 2)", async () => {
    const { report, exitCode } = await runGuardrail("deny-all", join(outDir, "deny-all"));
    expect(exitCode).toBe(2);
    expect(report.summary.valid).toBe(false);
    for (const scenario of report.scenarios) {
      for (const result of scenario.results) {
        if (scenario.kind === "control") {
          expect(result.pass, `control ${scenario.id}/${result.chain} should fail`).toBe(false);
        } else {
          expect(result.pass, `attack ${scenario.id}/${result.chain} should pass`).toBe(true);
        }
      }
    }
  });

  it("reference-policy passes every attack and every control (exit 0)", async () => {
    const { report, exitCode } = await runGuardrail(
      "reference-policy",
      join(outDir, "reference-policy"),
    );
    const failures = report.scenarios.flatMap((scenario) =>
      scenario.results
        .filter((r) => !r.pass)
        .map(
          (r) => `${scenario.id}/${r.chain}: ${r.worst.violations.map((v) => v.code).join(",")}`,
        ),
    );
    // Per functional-design.md §4: if this fails, the failures are recorded and sent to
    // the architect - the corpus is never tuned to the policy.
    expect(failures, `reference-policy failures:\n${failures.join("\n")}`).toEqual([]);
    expect(exitCode).toBe(0);
  });

  it("sdk-defaults produces a valid, non-crashing report", async () => {
    const { report } = await runGuardrail("sdk-defaults", join(outDir, "sdk-defaults"));
    expect(report.summary.valid).not.toBeNull();
    expect(report.config.guardrail_hooks).toEqual(["payment"]);
  });

  it("hostname-allowlist produces a valid, non-crashing report", async () => {
    const { report } = await runGuardrail("hostname-allowlist", join(outDir, "hostname-allowlist"));
    expect(report.summary.valid).not.toBeNull();
    expect(report.config.guardrail_hooks).toEqual(["payment", "transfer"]);
  });

  it("two allow-all runs produce a byte-identical report.json, minus timing", async () => {
    const run1 = await runGuardrail("allow-all", join(outDir, "run1"));
    const run2 = await runGuardrail("allow-all", join(outDir, "run2"));
    const strip = (r: Report) => toJson(stripTiming(r));
    expect(strip(run1.report)).toBe(strip(run2.report));
  }, 600_000);
});
