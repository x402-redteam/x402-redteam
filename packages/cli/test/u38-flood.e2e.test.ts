/**
 * U38 AC-20: a hostile fixture agent floods every adversary surface until the run is killed
 * (`--timeout 3`). The run must end inside the derived bound, harness memory must stay inside
 * its derived bound, and the run scores `fail` with `resource_limit`.
 *
 * Bound: 3 s timeout + 0.1 s single loop turn + 2 s SIGKILL grace + 10 s `idle()` + 3 s slack
 * = 18 s (functional-design.md AC-20).
 *
 * Memory (functional-design.md section 15, which replaces the 128 MiB RSS-growth bound): live
 * bytes (V8 `heapUsed` + `external`) read after a forced full GC, so neither V8's lazy collection
 * nor the allocator's page retention is counted. Two bounds, both over a settled baseline taken
 * after the warm-up run:
 * - peak, sampled every 250 ms during the run: under 64 MiB, the section 6.3 terms this fixture
 *   reaches (admitted bodies 4 x 8 MiB, refused bodies 24 MiB, run state 2 MiB = 58 MiB; it writes
 *   no log, so the 32 MiB scrub term does not apply);
 * - retained after the run's `close()`: under 4 MiB, half of one run's body budget.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";

const FIXTURE_CORPUS = new URL("./fixtures/corpus", import.meta.url).pathname;
const FLOOD_AGENT = fileURLToPath(new URL("./fixtures/flood-agent.mjs", import.meta.url));
const MAX_RUN_SECONDS = 18;
const MiB = 1024 * 1024;
const MAX_LIVE_PEAK_BYTES = 64 * MiB;
const MAX_RETAINED_BYTES = 4 * MiB;
const SAMPLE_MS = 250;

/** V8's `gc` without `--expose-gc` on the worker: the flag holds for contexts created after it. */
function exposeGc(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const gc = exposeGc();
    const live = () => {
      gc();
      const m = process.memoryUsage();
      return m.heapUsed + m.external;
    };
    // Three GCs 50 ms apart, so finalizers and released external buffers are settled.
    const settled = async () => {
      live();
      await tick(50);
      live();
      await tick(50);
      return live();
    };
    const base = await settled();
    const rssBefore = process.memoryUsage().rss;
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, live() - base);
    }, SAMPLE_MS);
    const start = performance.now();
    const { report } = await runSuite(options).finally(() => clearInterval(sampler));
    const seconds = (performance.now() - start) / 1000;
    const retained = (await settled()) - base;
    // RSS is reported, not asserted: it counts pages V8 and the allocator keep after a collection.
    const memory = `live peak ${(peak / MiB).toFixed(1)} MiB, retained ${(retained / MiB).toFixed(1)} MiB, rss growth ${((process.memoryUsage().rss - rssBefore) / MiB).toFixed(1)} MiB`;

    expect(seconds).toBeLessThan(MAX_RUN_SECONDS);
    expect(peak, memory).toBeLessThan(MAX_LIVE_PEAK_BYTES);
    expect(retained, memory).toBeLessThan(MAX_RETAINED_BYTES);
    const run = report.runs[0];
    expect(run?.limit_hit).toBeDefined();
    const worst = report.scenarios.find((s) => s.id === "prose-lure")?.results[0]?.worst;
    expect(worst?.status).toBe("fail");
    expect(worst?.violations.map((v) => v.code)).toContain("resource_limit");
  }, 120_000);
});
