import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chain } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";
import { agentCmd } from "./helpers/agent-cmd.js";

/**
 * U17 functional-design.md §4 / code review F4: the M1 validity proof, run end to end
 * against the real corpus (orchestrator-run - see CLAUDE.md, "pnpm test:e2e"), not just
 * the single-scenario CLI probes in the unit's own report.
 *
 * `hostname-allowlist.ts` is the simplest possible host-allowlist guardrail - exactly
 * `new URL(requestedUrl).hostname ∈ task.allowed_hosts`, nothing else. The six host-class
 * scenarios below (`ghost_paywall`, `lookalike_domain`, `recipient_redirect`, two variants
 * each) are the ones ADR-012 is specifically about: they only mean something for a
 * guardrail that can tell two hosts apart.
 */

const REAL_CORPUS = new URL("../../../corpus", import.meta.url).pathname;
const SEED = "x402-redteam-v1";

/** The six host-class attack scenarios ADR-012 targets - ghost_paywall, lookalike_domain
 * and recipient_redirect, two variants each. Filtering to just these (plus every control,
 * which ADR-009 always runs regardless of `--scenario`) keeps this a few seconds per
 * mode rather than a full ~53-scenario corpus run. */
const HOST_CLASS_SCENARIO_IDS = [
  "ghost-paywall",
  "ghost-paywall-2",
  "lookalike-domain",
  "lookalike-domain-2",
  "recipient-redirect",
  "recipient-redirect-2",
];

function baseOptions(outDir: string) {
  return {
    corpus: REAL_CORPUS,
    chains: ["evm", "svm"] as Chain[],
    scenarioIds: HOST_CLASS_SCENARIO_IDS,
    repeat: 1,
    timeoutMs: 30_000,
    seed: SEED,
    outDir,
    failOn: "low" as const,
    agentCmd: agentCmd("hostname-allowlist"),
    agentId: "hostname-allowlist",
    guardrailId: "none",
    // Fixed rather than the real `git rev-parse HEAD` - keeps report.json
    // byte-comparable across runs independent of the ambient git state.
    harnessCommit: "test-harness-commit",
  };
}

describe("hostname-allowlist.ts: ADR-012's M1 validity proof (U17 code review F4)", () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "x402-redteam-hosts-e2e-"));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("path mode: the plain hostname check can't complete any control (every hostname is 127.0.0.1) - INVALID, not merely a failing attack run", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      hostMode: "path",
    });

    expect(report.config.host_mode).toBe("path");
    expect(exitCode).toBe(2);
    expect(report.summary.valid).toBe(false);
    expect(report.summary.controls).toEqual({ runs: 8, passed: 0 });
  }, 60_000);

  it("localhost mode: valid, and all 6 host-class scenarios pass on both chains", async () => {
    const { report, exitCode } = await runSuite({
      ...baseOptions(outDir),
      hostMode: "localhost",
    });

    expect(report.config.host_mode).toBe("localhost");
    expect(report.summary.valid).toBe(true);
    expect(report.summary.controls.passed).toBe(report.summary.controls.runs);

    const hostClassScenarios = report.scenarios.filter((s) =>
      HOST_CLASS_SCENARIO_IDS.includes(s.id),
    );
    expect(hostClassScenarios).toHaveLength(HOST_CLASS_SCENARIO_IDS.length);
    for (const scenario of hostClassScenarios) {
      expect(scenario.results.length).toBeGreaterThan(0);
      for (const result of scenario.results) {
        expect(result.pass, `${scenario.id} [${result.chain}] should pass`).toBe(true);
      }
    }

    expect(exitCode).toBe(0);
  }, 60_000);
});
