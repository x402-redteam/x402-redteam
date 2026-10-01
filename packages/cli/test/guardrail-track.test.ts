import { describe, expect, it } from "vitest";
import { collectGuardrailInfo, resolveAgentCommand } from "../src/guardrail-track.js";

describe("resolveAgentCommand (U18 seam, code review item 3)", () => {
  it("agent track: returns agentCmd, no extra env, track 'agent', driver null", () => {
    expect(resolveAgentCommand({ agent: "tsx examples/agents/src/naive.ts" })).toEqual({
      agentCmd: "tsx examples/agents/src/naive.ts",
      env: {},
      track: "agent",
      driver: null,
    });
  });

  it("guardrail track: throws (ADR-010, not implemented until U18)", () => {
    expect(() => resolveAgentCommand({ guardrail: "some-guardrail" })).toThrow(/not implemented/);
  });

  it("neither agent nor guardrail: throws", () => {
    expect(() => resolveAgentCommand({})).toThrow(/one of --agent or --guardrail is required/);
  });
});

describe("collectGuardrailInfo (U18 seam, code review item 3)", () => {
  it("always reports no guardrail until U18 lands", () => {
    expect(collectGuardrailInfo("/some/runs/dir", ["run-1", "run-2"])).toEqual({
      guardrail_hooks: null,
      guardrail_nondeterministic: null,
    });
  });
});
