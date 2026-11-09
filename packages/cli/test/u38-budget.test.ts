/**
 * U38 (D3): a guardrail-track run whose driver stopped at its own request or leg budget
 * (`budget_exhausted: true` in the GDP record, exit 0) is never a pass. `run.ts` forces
 * `exit_code = 1`: an attack scores `error`, a control `agent_failed`. Same fake-driver
 * pattern as the guardrail-integrity test: the agent command only writes the GDP record.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSuite } from "../src/run.js";

const FIXTURE_ATTACK = fileURLToPath(new URL("./fixtures/corpus/prose-lure.yaml", import.meta.url));
const REAL_CONTROL = fileURLToPath(
  new URL("../../../corpus/controls/control-advertised-price.yaml", import.meta.url),
);

let work: string;
let corpus: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "x402-u38-budget-"));
  corpus = join(work, "corpus");
  mkdirSync(join(corpus, "controls"), { recursive: true });
  copyFileSync(FIXTURE_ATTACK, join(corpus, "prose-lure.yaml"));
  copyFileSync(REAL_CONTROL, join(corpus, "controls", "control-advertised-price.yaml"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function driverThatWrites(record: Record<string, unknown>): string {
  const script = `require("fs").writeFileSync(process.env.X402_GDP_RECORD_DIR+"/gdp.json", ${JSON.stringify(JSON.stringify(record))});`;
  return `node -e ${JSON.stringify(script)}`;
}

async function run(record: Record<string, unknown>) {
  return runSuite({
    corpus,
    chains: ["evm"],
    repeat: 1,
    timeoutMs: 30_000,
    seed: "x402-redteam-v1",
    outDir: resolve(work, "out"),
    failOn: "low",
    harnessCommit: "test-harness-commit",
    agentId: "fake-driver",
    guardrailId: "fake-guardrail",
    track: "guardrail",
    driver: "driver@2",
    agentCmd: driverThatWrites(record),
  });
}

const base = {
  hooks: ["payment"],
  name: "g",
  version: "1",
  nondeterministic: false,
  guardrail_errors: 0,
};

describe("U38 D3: budget_exhausted is never a pass", () => {
  it("an attack whose driver exhausted its budget scores error, a control scores agent_failed", async () => {
    const { report } = await run({ ...base, budget_exhausted: true });
    const attack = report.runs.find((r) => r.scenario_id === "prose-lure");
    const control = report.runs.find((r) => r.scenario_id === "control-advertised-price");
    expect(attack?.exit_code).toBe(1);
    expect(control?.exit_code).toBe(1);
    expect(attack?.limit_hit).toBeUndefined();

    const scenario = (id: string) => report.scenarios.find((s) => s.id === id);
    expect(scenario("prose-lure")?.results[0]?.worst.status).toBe("error");
    const controlWorst = scenario("control-advertised-price")?.results[0]?.worst;
    expect(controlWorst?.status).toBe("fail");
    expect(controlWorst?.violations.map((v) => v.code)).toContain("agent_failed");
  }, 60_000);

  it("the same driver without budget_exhausted scores the attack as a pass", async () => {
    const { report } = await run(base);
    const attack = report.runs.find((r) => r.scenario_id === "prose-lure");
    expect(attack?.exit_code).toBe(0);
    const scenario = report.scenarios.find((s) => s.id === "prose-lure");
    expect(scenario?.results[0]?.worst.status).toBe("pass");
  }, 60_000);
});

describe("U38 D2: the scrub manifest", () => {
  it("lists every log whose scrub finished, one name per run", async () => {
    const { report } = await run(base);
    const listed = readFileSync(resolve(work, "out", ".scrubbed-logs"), "utf8")
      .split("\n")
      .filter(Boolean)
      .sort();
    expect(listed).toEqual(report.runs.map((r) => `${r.run_id}.log`).sort());
  }, 60_000);
});
