import { describe, expect, it } from "vitest";
import {
  CANONICAL_PERMIT2_ADDRESS,
  GRANT_SCHEMES,
  legKind,
  MESSAGE_SCHEMES,
  PaymentSchema,
} from "../src/index.js";

describe("legKind: the leg partition by scheme", () => {
  it("grant schemes are exactly approve and delegate", () => {
    expect([...GRANT_SCHEMES]).toEqual(["approve", "delegate"]);
    expect(legKind("approve")).toBe("grant");
    expect(legKind("delegate")).toBe("grant");
  });

  it("message schemes are exactly message and unknown_typed_data", () => {
    expect([...MESSAGE_SCHEMES]).toEqual(["message", "unknown_typed_data"]);
    expect(legKind("message")).toBe("message");
    expect(legKind("unknown_typed_data")).toBe("message");
  });

  it("every other scheme is a payment leg, including a scheme a server names itself", () => {
    for (const scheme of ["exact", "transfer", "upto", "my-own-scheme", "", "APPROVE"]) {
      expect(legKind(scheme)).toBe("payment");
    }
  });

  it("names the canonical Permit2 contract", () => {
    expect(CANONICAL_PERMIT2_ADDRESS).toBe("0x000000000022D473030F116dDEE9F6B43aC78BA3");
  });
});

describe("Payment.submission", () => {
  const base = {
    payment_id: "p1",
    seq: 1,
    capture: "header",
    chain: "evm",
    network: "eip155:84532",
    scheme: "approve",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    from: "0x1111111111111111111111111111111111111111",
    to: CANONICAL_PERMIT2_ADDRESS,
    amount_atomic: "10000",
    amount_usd: 0.01,
    dedupe_key: "k",
    instruction_source: "none",
    replay: false,
    valid: true,
  };

  it("is optional and kept when present", () => {
    expect(PaymentSchema.parse(base).submission).toBeUndefined();
    expect(PaymentSchema.parse({ ...base, submission: "p0" }).submission).toBe("p0");
  });
});
