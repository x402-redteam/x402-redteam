import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectGuardrailInfo,
  type DriverGdpRecord,
  hasGdpRecord,
  readGdpRecordFromDir,
  readGuardrailErrors,
  resolveAgentCommand,
} from "../src/guardrail-track.js";

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

function record(overrides: Partial<DriverGdpRecord> = {}): DriverGdpRecord {
  return { hooks: ["payment"], nondeterministic: false, ...overrides };
}

describe("collectGuardrailInfo (ADR-010, U18)", () => {
  it("reports no guardrail when no run has a record (agent track)", () => {
    expect(collectGuardrailInfo([undefined, undefined])).toEqual({
      guardrail_hooks: null,
      guardrail_nondeterministic: null,
    });
  });

  it("reads the recorded hooks/nondeterministic, skipping a missing record", () => {
    expect(
      collectGuardrailInfo([
        undefined,
        record({ hooks: ["payment", "sign"], nondeterministic: true }),
      ]),
    ).toEqual({
      guardrail_hooks: ["payment", "sign"],
      guardrail_nondeterministic: true,
    });
  });

  it("ignores a record with malformed hooks and keeps looking", () => {
    expect(
      collectGuardrailInfo([
        record({ hooks: "not an array" }),
        record({ hooks: ["transfer"], nondeterministic: false }),
      ]),
    ).toEqual({
      guardrail_hooks: ["transfer"],
      guardrail_nondeterministic: false,
    });
  });

  // U18b item 3.
  it("hooks disagreeing across runs leads to guardrail_hooks: null, not whichever run was read first", () => {
    const info = collectGuardrailInfo([
      record({ hooks: ["payment"] }),
      record({ hooks: ["payment", "transfer"] }),
    ]);
    expect(info.guardrail_hooks).toBeNull();
  });

  // U18b item 3.
  it("guardrail_nondeterministic is the OR across every run that reported one", () => {
    const info = collectGuardrailInfo([
      record({ nondeterministic: false }),
      record({ nondeterministic: true }),
    ]);
    expect(info.guardrail_nondeterministic).toBe(true);
  });
});

describe("readGuardrailErrors (U18b item 2)", () => {
  it("returns undefined, never 0, when there is no record at all (e.g. a failed hello)", () => {
    expect(readGuardrailErrors(undefined)).toBeUndefined();
  });

  it("returns the recorded count when a record has one", () => {
    expect(readGuardrailErrors(record({ guardrail_errors: 3 }))).toBe(3);
  });

  it("returns undefined for a record with a malformed guardrail_errors field", () => {
    expect(readGuardrailErrors(record({ guardrail_errors: "not a number" }))).toBeUndefined();
  });
});

describe("hasGdpRecord (U18, regression)", () => {
  it("is false when there is no record", () => {
    expect(hasGdpRecord(undefined)).toBe(false);
  });

  it("is true when there is a record", () => {
    expect(hasGdpRecord(record())).toBe(true);
  });
});

/**
 * U18b item 1 (coordinator revision): `readGdpRecordFromDir` is the one place that still
 * touches the filesystem - reading `<dir>/gdp.json`, the private per-run directory
 * `run.ts` creates and the driver writes into (see packages/driver/src/main.ts).
 */
describe("readGdpRecordFromDir (U18b item 1)", () => {
  it("returns undefined when the directory has no gdp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-gdp-record-"));
    try {
      expect(readGdpRecordFromDir(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined for a malformed gdp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-gdp-record-"));
    try {
      writeFileSync(join(dir, "gdp.json"), "not json");
      expect(readGdpRecordFromDir(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a valid gdp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "x402-gdp-record-"));
    try {
      writeFileSync(
        join(dir, "gdp.json"),
        JSON.stringify({
          hooks: ["payment", "sign"],
          name: "x",
          version: "1",
          nondeterministic: true,
          guardrail_errors: 2,
        }),
      );
      expect(readGdpRecordFromDir(dir)).toEqual({
        hooks: ["payment", "sign"],
        name: "x",
        version: "1",
        nondeterministic: true,
        guardrail_errors: 2,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
