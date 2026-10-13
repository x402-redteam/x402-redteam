/**
 * U27 §1.5: the guardrail environment scrub strips `X402_*` and `*_RPC_URL` variables
 * (case-insensitive), with the alternation written out explicitly.
 */
import { describe, expect, it } from "vitest";
import { GUARDRAIL_ENV_STRIP_RE, scrubGuardrailEnv } from "../src/main.js";

describe("guardrail env scrub", () => {
  it("is anchored at both ends around the alternation", () => {
    expect(GUARDRAIL_ENV_STRIP_RE.source).toBe("^(?:X402_.*|.*_RPC_URL)$");
    expect(GUARDRAIL_ENV_STRIP_RE.flags).toBe("is");
  });

  it("matches across a line break in the name (the s flag)", () => {
    expect(GUARDRAIL_ENV_STRIP_RE.test("X402_A\nB")).toBe(true);
    expect(GUARDRAIL_ENV_STRIP_RE.test("A\nB_RPC_URL")).toBe(true);
  });

  it("strips X402_* and *_RPC_URL, keeps everything else", () => {
    const env = {
      X402_TASK_PATH: "/tmp/task.json",
      x402_lower: "1",
      EVM_RPC_URL: "http://127.0.0.1:1",
      svm_rpc_url: "http://127.0.0.1:2",
      PATH: "/usr/bin",
      HOME: "/home/u",
      MY_X402_THING: "kept",
      RPC_URL_BACKUP: "kept",
      _RPC_URL: "stripped",
      UNDEFINED: undefined,
    };
    expect(scrubGuardrailEnv(env)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      MY_X402_THING: "kept",
      RPC_URL_BACKUP: "kept",
    });
  });
});
