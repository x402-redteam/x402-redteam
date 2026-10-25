/**
 * U30-4 (owner decision 3, delta §2.6): the CI fuzz-smoke `mcp` leg, enabled after the private
 * triage of the 4 public cases closed. This pins that: the step exists in the fuzz-smoke job
 * only, no other workflow turns the env flag on, the leg's test is skipped without the flag,
 * and nothing in it can print agent output or oracle counts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Step {
  name?: string;
  if?: unknown;
  env?: Record<string, string>;
  run?: string;
}

const ci = parse(readFileSync(`${REPO_ROOT}.github/workflows/ci.yml`, "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const steps = ci.jobs["fuzz-smoke"]?.steps ?? [];
const leg = steps.find((s) => s.env?.FUZZ_SMOKE_MCP !== undefined);

describe("fuzz-smoke mcp leg (U30-4)", () => {
  it("is present in ci.yml, unconditional, after the fuzz e2e step", () => {
    expect(leg).toBeDefined();
    expect(leg?.if).toBeUndefined();
    expect(leg?.run).toContain("fuzz-smoke.e2e");
    const enabled = steps.find((s) => s.run?.includes("fuzz-smoke.e2e fuzz-diff.e2e"));
    expect(enabled).toBeDefined();
    expect(enabled?.if).toBeUndefined();
    expect(enabled?.env).toBeUndefined();
    expect(steps.indexOf(leg as Step)).toBeGreaterThan(steps.indexOf(enabled as Step));
  });

  it("no other workflow step sets the flag, and the comment records the closed triage", () => {
    const dir = `${REPO_ROOT}.github/workflows`;
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
      const text = readFileSync(`${dir}/${f}`, "utf8");
      const hits = text.split("\n").filter((l) => l.includes("FUZZ_SMOKE_MCP"));
      expect(hits.length, f).toBe(f === "ci.yml" ? 1 : 0);
    }
    const ciText = readFileSync(`${dir}/ci.yml`, "utf8");
    expect(ciText).toMatch(/enabled after the private triage of the 4 public cases closed/);
  });

  it("the leg's test runs only with the flag, and prints no agent output or oracle counts", () => {
    const text = readFileSync(
      fileURLToPath(new URL("./fuzz-smoke.e2e.test.ts", import.meta.url)),
      "utf8",
    );
    const leg = text.slice(text.indexOf("fuzz smoke, mcp leg"));
    expect(text).toContain('process.env.FUZZ_SMOKE_MCP !== "1"');
    // it never interpolates a run's or diff's stdout/stderr other than the refusal line
    expect(leg).not.toMatch(/run\.stderr|run\.stdout|diff\.stdout|fuzz\.stderr/);
    expect(leg).not.toMatch(/\bflagged\b|\binvariant\b|\bvoided\b/);
    expect(leg).toContain('"--quiet"');
  });
});
