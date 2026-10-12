/**
 * U26-2 acceptance (design §3.4, review B2/B4/M2/M4/m7): each new capability, proved on a
 * draft scenario that lives only in this test's fixture corpus (U26-3 adds the real
 * corpus scenarios and categories).
 *
 * - allow-all (guardrail track) fails every draft and reference-policy passes every draft;
 *   a check-then-act guardrail fails the parallel budget draft.
 * - naive fails every draft; guarded passes every draft (it pins prompt-named
 *   recipients); the promptonly readiness probe reaches and fails the challenge-class
 *   drafts (m7); sdk-default signs the SDK approval.
 * - A sign request the guardrail denies leaves no leg at all (architect change 2).
 * - Two runs of each guardrail give a byte-identical report.json minus timing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Report } from "@x402-redteam/scorer";
import { stripTiming, toJson } from "@x402-redteam/scorer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAgentCommand } from "../src/guardrail-track.js";
import { runSuite } from "../src/run.js";
import { agentCmd, guardrailCmd } from "./helpers/agent-cmd.js";

const DRAFT_CORPUS = fileURLToPath(new URL("./fixtures/u26-draft-corpus", import.meta.url));
const CHECK_THEN_ACT = `"${process.execPath}" "${fileURLToPath(
  new URL("./fixtures/guardrails/check-then-act.mjs", import.meta.url),
)}"`;
const SEED = "x402-redteam-v1";

const EXPECTED_CODE: Record<string, string> = {
  "draft-sdk-approval": "standing_approval",
  "draft-7702-delegation": "authority_grant",
  "draft-raw-digest": "off_scheme_signature",
  "draft-parallel-budget": "over_total",
  "draft-poisoned-payto": "wrong_recipient",
};

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), "x402-u26-capabilities-"));
});

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function options(dir: string) {
  return {
    corpus: DRAFT_CORPUS,
    chains: ["evm" as const],
    repeat: 1,
    timeoutMs: 60_000,
    seed: SEED,
    outDir: join(outDir, dir),
    failOn: "low" as const,
    harnessCommit: "test-harness-commit",
  };
}

async function runGuardrail(cmd: string, guardrailId: string, dir: string) {
  const resolved = resolveAgentCommand({ guardrail: cmd });
  return runSuite({ ...resolved, ...options(dir), agentId: "driver", guardrailId });
}

async function runAgent(script: Parameters<typeof agentCmd>[0], dir: string) {
  return runSuite({
    agentCmd: agentCmd(script),
    ...options(dir),
    agentId: script,
    guardrailId: "none",
  });
}

/** scenario id -> { pass, codes } for the single EVM result of each draft. */
function outcomes(report: Report): Record<string, { pass: boolean; codes: string[] }> {
  const out: Record<string, { pass: boolean; codes: string[] }> = {};
  for (const scenario of report.scenarios) {
    const result = scenario.results[0];
    if (!result) continue;
    out[scenario.id] = {
      pass: result.pass,
      codes: result.worst.violations.map((v) => v.code),
    };
  }
  return out;
}

/** scenario id -> whether its single attempt reached the attack surface (ADR-016). */
function reached(report: Report): Record<string, boolean | null | undefined> {
  const out: Record<string, boolean | null | undefined> = {};
  for (const scenario of report.scenarios) {
    out[scenario.id] = scenario.results[0]?.attempts[0]?.reached;
  }
  return out;
}

const strip = (r: Report) => toJson(stripTiming(r));
const CONTROL = "draft-permit2-control";

describe("U26-2 draft scenarios through the guardrail track", () => {
  it("allow-all fails every draft with the expected code, and two runs are byte-identical", async () => {
    const run1 = await runGuardrail(guardrailCmd("allow-all"), "allow-all", "allow-all-1");
    const run2 = await runGuardrail(guardrailCmd("allow-all"), "allow-all", "allow-all-2");
    const got = outcomes(run1.report);
    expect(Object.keys(got).sort()).toEqual([...Object.keys(EXPECTED_CODE), CONTROL].sort());
    // The driver fetches every URL twice, so allow-all pays the control twice; a control
    // is still judged on its utility (paid and delivered), as on the real corpus.
    expect(got[CONTROL]?.pass).toBe(true);
    for (const [id, code] of Object.entries(EXPECTED_CODE)) {
      expect(got[id]?.pass, `${id} should fail under allow-all`).toBe(false);
      expect(got[id]?.codes, id).toContain(code);
    }
    for (const id of Object.keys(EXPECTED_CODE)) {
      expect(reached(run1.report)[id], `${id} reached under allow-all`).toBe(true);
    }
    expect(run1.report.summary.agent_errors).toBe(0);
    expect(run1.report.summary.capture_layers.submitted).toBe(2);
    expect(strip(run2.report)).toBe(strip(run1.report));
  }, 300_000);

  it("reference-policy passes every draft (exit 0), and two runs are byte-identical", async () => {
    const run1 = await runGuardrail(guardrailCmd("reference-policy"), "reference", "reference-1");
    const run2 = await runGuardrail(guardrailCmd("reference-policy"), "reference", "reference-2");
    const got = outcomes(run1.report);
    for (const id of [...Object.keys(EXPECTED_CODE), CONTROL]) {
      expect(got[id], `${id} under reference-policy: ${got[id]?.codes.join(",")}`).toEqual({
        pass: true,
        codes: [],
      });
    }
    expect(run1.exitCode).toBe(0);
    expect(run1.report.config.guardrail_hooks).toEqual(["payment", "transfer", "sign"]);
    // Architect change 2: the driver signs sign requests with a signer that never reports
    // to the ledger, so a denied request leaves no shim and no submitted leg.
    for (const id of ["draft-7702-delegation", "draft-raw-digest"]) {
      const runs = run1.report.runs.filter((r) => r.scenario_id === id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.payments, id).toEqual([]);
      expect(reached(run1.report)[id], `${id} reached under reference-policy`).toBe(true);
    }
    expect(strip(run2.report)).toBe(strip(run1.report));
  }, 300_000);

  it("a check-then-act guardrail overspends the parallel budget, and two runs are byte-identical", async () => {
    const run1 = await runGuardrail(CHECK_THEN_ACT, "check-then-act", "check-then-act-1");
    const run2 = await runGuardrail(CHECK_THEN_ACT, "check-then-act", "check-then-act-2");
    const parallel = outcomes(run1.report)["draft-parallel-budget"];
    expect(parallel?.pass).toBe(false);
    expect(parallel?.codes).toContain("over_total");
    expect(run1.report.summary.guardrail_errors).toBe(0);
    expect(strip(run2.report)).toBe(strip(run1.report));
  }, 300_000);
});

describe("U26-2 draft scenarios through the agent track", () => {
  it("naive fails every draft", async () => {
    const { report } = await runAgent("naive", "naive");
    const got = outcomes(report);
    for (const [id, code] of Object.entries(EXPECTED_CODE)) {
      expect(got[id]?.pass, `${id} should fail under naive`).toBe(false);
      expect(got[id]?.codes, id).toContain(code);
    }
  }, 300_000);

  it("guarded passes every draft and the control, including the poisoned payTo and the parallel budget", async () => {
    const { report } = await runAgent("guarded", "guarded");
    const got = outcomes(report);
    for (const id of [...Object.keys(EXPECTED_CODE), CONTROL]) {
      expect(got[id], `${id} under guarded: ${got[id]?.codes.join(",")}`).toEqual({
        pass: true,
        codes: [],
      });
    }
  }, 300_000);

  it("sdk-default signs the SDK approval and pays the poisoned and over-budget drafts", async () => {
    const { report } = await runAgent("sdk-default", "sdk-default");
    const got = outcomes(report);
    for (const id of ["draft-sdk-approval", "draft-poisoned-payto", "draft-parallel-budget"]) {
      expect(got[id]?.pass, `${id} should fail under sdk-default`).toBe(false);
      expect(got[id]?.codes, id).toContain(EXPECTED_CODE[id]);
    }
    // It reads no prose and throws on a 402 without an x402 challenge, so it never answers
    // a sign request.
    for (const id of ["draft-7702-delegation", "draft-raw-digest"]) {
      expect(got[id], id).toEqual({ pass: true, codes: [] });
    }
  }, 300_000);

  it("the promptonly readiness probe can reach the challenge-class drafts (m7)", async () => {
    const { report } = await runAgent("promptonly", "promptonly");
    const got = outcomes(report);
    for (const id of ["draft-sdk-approval", "draft-raw-digest", "draft-poisoned-payto"]) {
      expect(reached(report)[id], `${id} reached under promptonly`).toBe(true);
      expect(got[id]?.pass, `${id} should fail under promptonly`).toBe(false);
      expect(got[id]?.codes, id).toContain(EXPECTED_CODE[id]);
    }
  }, 300_000);
});
