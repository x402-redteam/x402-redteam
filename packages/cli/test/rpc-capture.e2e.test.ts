import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chain } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";
import { agentCmd } from "./helpers/agent-cmd.js";

/**
 * U10 acceptance test (functional-design.md §6), run against the *real*
 * `corpus/prose-payment.yaml` (not a fixture): a direct transfer parsed out of page
 * prose is observed at the chain boundary (ADR-013), whether or not the agent uses
 * the TypeScript shim.
 */
const here = dirname(fileURLToPath(import.meta.url));
const REAL_CORPUS = join(here, "..", "..", "..", "corpus");
const SEED = "x402-redteam-v1";

function baseOptions(outDir: string) {
  return {
    corpus: REAL_CORPUS,
    scenarioIds: ["prose-payment"],
    // Controls now always run alongside a --scenario filter (ADR-009 §B3, U9-B); this
    // test only cares about prose-payment, so skip them to keep report.runs scoped.
    skipControls: true,
    chains: ["evm", "svm"] as Chain[],
    repeat: 1,
    timeoutMs: 30_000,
    seed: SEED,
    outDir,
    failOn: "low" as const,
  };
}

describe("U10 rpc-capture E2E (real corpus/prose-payment.yaml)", () => {
  let outDir: string;
  let previousNoShim: string | undefined;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-rpc-capture-"));
    previousNoShim = process.env.NAIVE_NO_SHIM;
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
    if (previousNoShim === undefined) {
      delete process.env.NAIVE_NO_SHIM;
    } else {
      process.env.NAIVE_NO_SHIM = previousNoShim;
    }
  });

  it("NAIVE_NO_SHIM=1: naive fails prose-payment on both chains, observed via RPC alone (no shim)", async () => {
    process.env.NAIVE_NO_SHIM = "1";
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      agentCmd: agentCmd("naive"),
      agentId: "naive",
      guardrailId: "none",
      passEnv: ["NAIVE_NO_SHIM"],
    });

    expect(exitCode).toBe(1);
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.scenario_id).toBe("prose-payment");
      const prosePayment = run.payments.find((p) => p.instruction_source === "prose");
      expect(prosePayment, `${run.chain}: expected a prose payment`).toBeDefined();
      expect(prosePayment?.capture).toBe("rpc");
    }

    const scenario = report.scenarios.find((s) => s.id === "prose-payment");
    expect(scenario).toBeDefined();
    for (const result of scenario?.results ?? []) {
      expect(result.pass, `${result.chain} should fail`).toBe(false);
    }
  });

  it("default naive (shim + RPC both submit the same tx): one payment per chain, capture rpc+shim", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      agentCmd: agentCmd("naive"),
      agentId: "naive",
      guardrailId: "none",
    });

    expect(exitCode).toBe(1);
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      const prosePayments = run.payments.filter((p) => p.instruction_source === "prose");
      expect(prosePayments, `${run.chain}: exactly one merged payment, not two`).toHaveLength(1);
      expect(prosePayments[0]?.capture).toBe("rpc+shim");
      expect(prosePayments[0]?.replay).toBe(false);
    }
  });

  it("guarded is unaffected: no prose scan, 0 RPC payments, exit 0", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      agentCmd: agentCmd("guarded"),
      agentId: "guarded",
      guardrailId: "policy-v1",
    });

    expect(exitCode).toBe(0);
    expect(report.runs).toHaveLength(2);
    for (const run of report.runs) {
      expect(run.payments.some((p) => p.capture.includes("rpc"))).toBe(false);
    }
  });
});
