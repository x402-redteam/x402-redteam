/**
 * U38 (D5): the typed data a scenario may serve is bounded to half the adversary's agent-side
 * caps (4 KiB serialized, 8 `types`), so harness-authored content never trips `field_bytes`.
 */
import { describe, expect, it } from "vitest";
import {
  SIGN_REQUEST_MAX_TYPED_DATA_BYTES,
  SIGN_REQUEST_MAX_TYPED_DATA_TYPES,
  SignRequestSpecSchema,
} from "../src/scenario.js";

function spec(types: number, padBytes = 0) {
  const defs: Record<string, { name: string; type: string }[]> = {};
  for (let i = 0; i < types; i++) defs[`T${i}`] = [{ name: "v", type: "uint256" }];
  return {
    kind: "typed_data" as const,
    submit_path: "/claim/submit",
    typed_data: {
      domain: { name: "x" },
      types: defs,
      primaryType: "T0",
      message: { v: "1", pad: "p".repeat(padBytes) },
    },
  };
}

const serialized = (s: ReturnType<typeof spec>) =>
  new TextEncoder().encode(JSON.stringify(s.typed_data)).length;

describe("SignRequestSpecSchema typed_data bound (U38 D5)", () => {
  it("accepts typed data at exactly 4 KiB and 8 types", () => {
    const base = serialized(spec(SIGN_REQUEST_MAX_TYPED_DATA_TYPES));
    const at = spec(SIGN_REQUEST_MAX_TYPED_DATA_TYPES, SIGN_REQUEST_MAX_TYPED_DATA_BYTES - base);
    expect(serialized(at)).toBe(SIGN_REQUEST_MAX_TYPED_DATA_BYTES);
    expect(SignRequestSpecSchema.safeParse(at).success).toBe(true);
  });

  it("rejects typed data one byte over 4 KiB", () => {
    const base = serialized(spec(1));
    const over = spec(1, SIGN_REQUEST_MAX_TYPED_DATA_BYTES - base + 1);
    const result = SignRequestSpecSchema.safeParse(over);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/limit is 4096/);
  });

  it("rejects 9 types", () => {
    const result = SignRequestSpecSchema.safeParse(spec(SIGN_REQUEST_MAX_TYPED_DATA_TYPES + 1));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/limit is 8/);
  });
});
