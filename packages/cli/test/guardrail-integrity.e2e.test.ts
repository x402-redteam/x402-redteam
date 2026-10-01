/**
 * U18b item 1/3 (ADR-010 §2, coordinator revision): exercises `run.ts`'s guardrail-track
 * bookkeeping around the driver's private per-run GDP record directory
 * (`X402_GDP_RECORD_DIR`). Most of this stays with a fake `agentCmd` standing in for the
 * driver (never touches the real driver/guardrail subprocess machinery -
 * `driver-calibration.e2e.test.ts` does that, orchestrator-run), so it's fast enough to
 * run on its own; the relative-path and env-leak checks go through the real driver and a
 * real guardrail, since those are specifically about what the driver does with its
 * guardrail subprocess's cwd/env.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chain } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentCommand } from "../src/guardrail-track.js";
import { runSuite } from "../src/run.js";

const require = createRequire(import.meta.url);

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const SEED = "x402-redteam-v1";
const SCENARIO_ID = "prose-lure";
const CHAIN: Chain = "evm";

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "x402-guardrail-integrity-"));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function baseOptions() {
  return {
    corpus: FIXTURE_CORPUS,
    chains: [CHAIN],
    scenarioIds: [SCENARIO_ID],
    repeat: 1,
    timeoutMs: 30_000,
    seed: SEED,
    outDir,
    failOn: "low" as const,
    harnessCommit: "test-harness-commit",
    agentId: "fake-driver",
    guardrailId: "fake-guardrail",
    // This fixture corpus has no corpus/controls/**; irrelevant to what these tests
    // check (run-level exit_code/guardrail_errors, not summary.valid).
    skipControls: true,
    track: "guardrail" as const,
    driver: "driver@1",
  };
}

describe("run.ts guardrail-track integrity: private GDP record dir (U18b item 1/3)", () => {
  it("a guardrail-track run that exits 0 with no record becomes exit_code 1, guardrail_errors undefined", async () => {
    // `agentCmd: "true"` never writes a record into `X402_GDP_RECORD_DIR` at all.
    const { report } = await runSuite({ ...baseOptions(), agentCmd: "true" });
    expect(report.runs).toHaveLength(1);
    const run = report.runs[0];
    expect(run?.exit_code).toBe(1);
    expect(run?.guardrail_errors).toBeUndefined();
  });

  it("reads the record from the private per-run dir, copies it to out/runs/ for audit, then deletes the dir", async () => {
    // Captures the actual `X402_GDP_RECORD_DIR` run.ts hands it (a fresh mkdtemp path,
    // unknown ahead of time) into a side file this test can read back afterwards.
    const capturedDirFile = resolve(outDir, "captured-record-dir.txt");
    const record = {
      hooks: ["payment"],
      name: "fake",
      version: "1.0.0",
      nondeterministic: false,
      guardrail_errors: 2,
    };
    const script =
      `const fs=require("fs");` +
      `const d=process.env.X402_GDP_RECORD_DIR;` +
      `fs.writeFileSync(d+"/gdp.json", ${JSON.stringify(JSON.stringify(record))});` +
      `fs.writeFileSync(${JSON.stringify(capturedDirFile)}, d);`;
    const agentCmd = `node -e ${JSON.stringify(script)}`;

    const { report } = await runSuite({ ...baseOptions(), agentCmd });
    const run = report.runs[0];
    expect(run?.exit_code).toBe(0);
    expect(run?.guardrail_errors).toBe(2);

    const capturedDir = readFileSync(capturedDirFile, "utf8");
    // Deleted after run.ts read it back - never left behind for a guardrail (or anyone
    // else) to find afterwards.
    expect(existsSync(capturedDir)).toBe(false);

    // The audit copy run.ts writes to the shared out/ tree, for a human to inspect -
    // never read back by the harness itself.
    const auditCopyPath = resolve(outDir, "runs", `${run?.run_id}.gdp.json`);
    expect(JSON.parse(readFileSync(auditCopyPath, "utf8"))).toEqual(record);
  });
});

describe("real driver + guardrail subprocess: cwd and env (U18b item 1, coordinator revision)", () => {
  it("a guardrail command with a relative path still works (driver keeps its own cwd)", async () => {
    const allowAllAbs = fileURLToPath(
      new URL("../../../examples/guardrails/allow-all.ts", import.meta.url),
    );
    const allowAllRelative = relative(process.cwd(), allowAllAbs);
    const tsxBin = require.resolve("tsx/cli");
    const resolved = resolveAgentCommand({
      guardrail: `node "${tsxBin}" "${allowAllRelative}"`,
    });
    const { report } = await runSuite({ ...resolved, ...baseOptions() });
    const run = report.runs[0];
    // A broken relative path would mean the guardrail subprocess never starts -
    // `hello` fails, the driver exits non-zero, and no guardrail_errors is ever
    // recorded. Succeeding here proves the relative path resolved against the
    // driver's own (inherited) cwd, not some isolated directory.
    expect(run?.exit_code).toBe(0);
    expect(run?.guardrail_errors).toBe(0);
  });

  it("the guardrail's env has no X402_ variable naming the record directory", async () => {
    const echoEnvPath = fileURLToPath(
      new URL("./fixtures/guardrails/echo-env.mjs", import.meta.url),
    );
    const resolved = resolveAgentCommand({ guardrail: `node "${echoEnvPath}"` });
    const { report } = await runSuite({ ...resolved, ...baseOptions() });
    const run = report.runs[0];
    expect(run?.exit_code).toBe(0);
    // collectGuardrailInfo/the run record don't carry `name` through, so read it back
    // from the audit copy the harness wrote.
    const auditCopy = JSON.parse(
      readFileSync(resolve(outDir, "runs", `${run?.run_id}.gdp.json`), "utf8"),
    );
    const guardrailEnvKeys: string[] = JSON.parse(auditCopy.name);
    expect(guardrailEnvKeys.some((k) => k.startsWith("X402_"))).toBe(false);
  });
});
