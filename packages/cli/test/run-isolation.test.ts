import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chain } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";

const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const ESCAPING_AGENT = fileURLToPath(new URL("./fixtures/escaping-agent.mjs", import.meta.url));
const SEED = "x402-redteam-v1";

/**
 * Each run gets its own fresh adversary/port, closed again before the next run starts
 * (run.ts). This agent makes one ordinary request (so the run's startup clock starts),
 * then spawns a detached grandchild that sends one more request, later, on its own - and
 * exits immediately, without waiting for it. The grandchild's request is always sent to
 * *this* run's own base URL (the one it was handed); by the time it actually fires, this
 * run's own listener is already closed and the run after it is listening on a different
 * port, so the request can only fail to connect. It must never be recorded into the next
 * run's ledger.
 */
describe("run isolation: a detached grandchild that outlives its run cannot pollute the next run's ledger", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-run-isolation-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("every run after the first has only its own traffic, never a previous run's late request", async () => {
    const { report } = await runSuite({
      agentCmd: `"${process.execPath}" "${ESCAPING_AGENT}"`,
      corpus: FIXTURE_CORPUS,
      scenarioIds: ["prose-lure", "redirect-hijack", "retry-storm-fixture"],
      chains: ["evm"] as Chain[],
      repeat: 1,
      timeoutMs: 10_000,
      startupTimeoutMs: 10_000,
      seed: SEED,
      outDir,
      agentId: "escaping-agent",
      guardrailId: "none",
      failOn: "low",
      // Fixed rather than the real `git rev-parse HEAD` - keeps this test's assertions
      // independent of the ambient git state.
      harnessCommit: "test-harness-commit",
    });

    // `report.runs` is sorted by `run_id` (a hash) for determinism, not by execution
    // order, so look runs up by scenario id rather than by array position. Scenarios
    // execute in alphabetical id order (run.ts): prose-lure, then redirect-hijack, then
    // retry-storm-fixture - each of the latter two is one a stray, late request from an
    // earlier run could have landed on. Every run must show exactly the one ordinary
    // request its own agent made - never that request plus an escaped one from a run
    // before it.
    const byScenario = new Map(report.runs.map((r) => [r.scenario_id, r]));
    for (const id of ["prose-lure", "redirect-hijack", "retry-storm-fixture"]) {
      expect(byScenario.get(id)?.requests.length).toBe(1);
    }
  });
});
