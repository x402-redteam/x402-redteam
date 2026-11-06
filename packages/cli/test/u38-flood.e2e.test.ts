/**
 * U38 AC-20: a hostile fixture agent floods every adversary surface until the run is killed
 * (`--timeout 3`). The run must end inside the derived bound, harness memory must stay inside
 * its derived bound, and the run scores `fail` with `resource_limit`.
 *
 * Bound: 3 s timeout + 0.1 s single loop turn + 2 s SIGKILL grace + 10 s `idle()` + 3 s slack
 * = 18 s (functional-design.md AC-20). RSS growth: the section 6.3 bound of about 90 MiB plus GC
 * slack = 128 MiB.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const FLOOD_AGENT = fileURLToPath(new URL("./fixtures/flood-agent.mjs", import.meta.url));
const MAX_RUN_SECONDS = 18;
const MAX_RSS_GROWTH_BYTES = 128 * 1024 * 1024;

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), "x402-u38-flood-"));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe("U38 AC-20: end-to-end flood", () => {
  it("ends inside the derived time and memory bounds and scores fail with resource_limit", async () => {
    const options = {
      corpus: FIXTURE_CORPUS,
      chains: ["evm" as const],
      scenarioIds: ["prose-lure"],
      repeat: 1,
      timeoutMs: 3000,
      seed: "x402-redteam-v1",
      outDir,
      failOn: "low" as const,
      harnessCommit: "test-harness-commit",
      agentId: "flood",
      guardrailId: "none",
      skipControls: true,
      agentCmd: `node "${FLOOD_AGENT}"`,
    };
    // Warm up so module loading and JIT are not counted as growth.
    await runSuite({ ...options, outDir: join(outDir, "warm"), timeoutMs: 1000 });
    globalThis.gc?.();
    const before = process.memoryUsage().rss;
    const start = performance.now();
    const { report } = await runSuite(options);
    const seconds = (performance.now() - start) / 1000;
    const growth = process.memoryUsage().rss - before;

    expect(seconds).toBeLessThan(MAX_RUN_SECONDS);
    expect(growth).toBeLessThan(MAX_RSS_GROWTH_BYTES);
    const run = report.runs[0];
    expect(run?.limit_hit).toBeDefined();
    const worst = report.scenarios.find((s) => s.id === "prose-lure")?.results[0]?.worst;
    expect(worst?.status).toBe("fail");
    expect(worst?.violations.map((v) => v.code)).toContain("resource_limit");
  }, 120_000);
});
