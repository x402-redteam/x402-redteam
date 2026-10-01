import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectGuardrailInfo, resolveAgentCommand } from "../src/guardrail-track.js";

describe("resolveAgentCommand (ADR-010, U18)", () => {
  it("agent track: returns agentCmd, no extra env, track 'agent', driver null", () => {
    expect(resolveAgentCommand({ agent: "tsx examples/agents/src/naive.ts" })).toEqual({
      agentCmd: "tsx examples/agents/src/naive.ts",
      env: {},
      track: "agent",
      driver: null,
    });
  });

  it("guardrail track: runs the driver, forwards the guardrail cmd via env, track 'guardrail'", () => {
    const resolved = resolveAgentCommand({ guardrail: "some-guardrail" });
    expect(resolved.agentCmd).toMatch(/^node ".*x402-redteam-driver\.mjs"$/);
    expect(resolved.env).toEqual({ X402_GUARDRAIL_CMD: "some-guardrail" });
    expect(resolved.track).toBe("guardrail");
    expect(resolved.driver).toBe("driver@1");
  });

  it("neither agent nor guardrail: throws", () => {
    expect(() => resolveAgentCommand({})).toThrow(/one of --agent or --guardrail is required/);
  });
});

describe("collectGuardrailInfo (ADR-010, U18)", () => {
  it("reports no guardrail when no *.gdp.json files exist (agent track)", () => {
    expect(collectGuardrailInfo("/some/runs/dir", ["run-1", "run-2"])).toEqual({
      guardrail_hooks: null,
      guardrail_nondeterministic: null,
    });
  });

  it("reads the first run's recorded hello response", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-guardrail-info-"));
    try {
      writeFileSync(
        join(dir, "run-2.gdp.json"),
        JSON.stringify({
          hooks: ["payment", "sign"],
          name: "x",
          version: "1",
          nondeterministic: true,
        }),
      );
      expect(collectGuardrailInfo(dir, ["run-1", "run-2"])).toEqual({
        guardrail_hooks: ["payment", "sign"],
        guardrail_nondeterministic: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a malformed record and keeps looking", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-guardrail-info-"));
    try {
      writeFileSync(join(dir, "run-1.gdp.json"), "not json");
      writeFileSync(
        join(dir, "run-2.gdp.json"),
        JSON.stringify({ hooks: ["transfer"], name: "x", version: "1", nondeterministic: false }),
      );
      expect(collectGuardrailInfo(dir, ["run-1", "run-2"])).toEqual({
        guardrail_hooks: ["transfer"],
        guardrail_nondeterministic: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
