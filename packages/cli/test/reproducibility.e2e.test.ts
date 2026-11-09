/**
 * U36-c (design §6.1, §6.3, §10.4): the reproducibility check through the real driver.
 * AC-c1 (a call-order flip is rejected), AC-c1b (a memoiser outside the reset scope still
 * passes: the documented residual), AC-c5 (report determinism at repeat 2) and the fresh
 * HOME / TMPDIR per run.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Chain } from "@x402-redteam/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgentCommand } from "../src/guardrail-track.js";
import { runSuite } from "../src/run.js";

const FIXTURE_CORPUS = fileURLToPath(new URL("./fixtures/corpus", import.meta.url));
const FLAKY = fileURLToPath(new URL("./fixtures/guardrails/flaky-state.mjs", import.meta.url));
const ECHO_STATE = fileURLToPath(new URL("./fixtures/guardrails/echo-state.mjs", import.meta.url));
const SEED = "x402-redteam-v1";
// AC-c1 needs the two passes to run the legs in DIFFERENT orders. For the 3 fixture legs,
// SEED happens to shuffle attempts 1 and 2 identically (probability 1/3! per seed), which
// would make an order-dependent guardrail look reproducible. This seed shuffles them apart.
const ORDER_SEED = "ac-c1-order-d";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "x402-repro-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function options(guardrail: string, outName: string, repeat: number | null = 2, seed = SEED) {
  return {
    ...resolveAgentCommand({ guardrail }),
    corpus: FIXTURE_CORPUS,
    chains: ["evm"] as Chain[],
    repeat: repeat ?? undefined,
    timeoutMs: 30_000,
    seed,
    outDir: join(work, outName),
    failOn: "low" as const,
    harnessCommit: "test-harness-commit",
    agentId: "driver",
    guardrailId: "fixture-guardrail",
    skipControls: true,
    track: "guardrail" as const,
    driver: "driver@2",
  };
}

describe("reproducibility check (real driver)", () => {
  it("AC-c1: a deterministic declaration with a call-order flip is not reproduced", async () => {
    const cmd = `node "${FLAKY}" "${join(work, "state-flip.json")}" order 3`;
    const { report } = await runSuite(options(cmd, "flip", 2, ORDER_SEED));
    expect(report.summary.reproducibility).toMatchObject({
      declared: "deterministic",
      consistent: false,
    });
    expect(report.summary.reproducibility?.inconsistent_legs).toBeGreaterThan(0);
  });

  it("AC-c1b (residual): a memoiser keyed on the request, outside the reset scope, passes", async () => {
    const cmd = `node "${FLAKY}" "${join(work, "state-memo.json")}" memo 20`;
    const { report } = await runSuite(options(cmd, "memo"));
    expect(report.summary.reproducibility).toEqual({
      declared: "deterministic",
      consistent: true,
      inconsistent_legs: 0,
      excluded_error_legs: 0,
      exclusion_cap_exceeded: false,
    });
  });

  it("every run starts with a fresh HOME and TMPDIR, removed afterwards", async () => {
    const { report } = await runSuite(options(`node "${ECHO_STATE}"`, "fresh"));
    expect(report.runs.length).toBe(6); // 3 scenarios x evm x 2 passes
    const homes = new Set<string>();
    for (const file of readdirSync(join(work, "fresh", "runs")).filter((f) =>
      f.endsWith(".gdp.json"),
    )) {
      const rec = JSON.parse(readFileSync(resolve(work, "fresh", "runs", file), "utf8"));
      const seen = JSON.parse(rec.name) as { home: string; tmp: string; leftOver: boolean };
      expect(seen.leftOver).toBe(false);
      expect(seen.home).not.toBe(process.env.HOME);
      expect(seen.tmp).toBe(seen.home);
      homes.add(seen.home);
    }
    expect(homes.size).toBe(6);
    for (const h of homes) expect(readdirSync(tmpdir())).not.toContain(h.split("/").pop());
  });

  it("AC-c5: report.json minus timing is byte-identical across two repeat-2 runs", async () => {
    const strip = (r: unknown): string => {
      const o = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
      o.timing = undefined;
      return JSON.stringify(o);
    };
    const cmd = `node "${ECHO_STATE}"`;
    const a = await runSuite(options(cmd, "det-a"));
    const b = await runSuite(options(cmd, "det-b"));
    expect(strip(a.report)).toBe(strip(b.report));
    expect(a.report.config.repeat).toBe(2);
  });

  it("M3: without --repeat the guardrail's declaration picks 2 or 3 passes", async () => {
    const det = await runSuite(options(`node "${ECHO_STATE}"`, "auto-det", null));
    expect(det.report.config.repeat).toBe(2);
    expect(det.report.config.guardrail_nondeterministic).toBe(false);
    const non = await runSuite(options(`node "${ECHO_STATE}" nondeterministic`, "auto-non", null));
    expect(non.report.config.repeat).toBe(3);
    expect(non.report.config.guardrail_nondeterministic).toBe(true);
    expect(non.report.runs.length).toBe(9);
  });
});
