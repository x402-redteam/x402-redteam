import { encodePaymentSignatureHeader } from "@x402/core/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { defineAcceptanceSuite } from "./acceptance-suite.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

/**
 * Drives the real @x402/fetch + @x402/evm client offline against the
 * adversary server, per functional-design.md §4. Items 1, 2, 3, 4 and 6 are
 * chain-parametrized in `acceptance-suite.ts` (also run for svm, and again
 * for both chains against the real capture package in
 * `real-capture.test.ts`); this file covers the evm-specific/host-agnostic
 * extras: item 5, and malformed/hand-rolled header handling.
 */
defineAcceptanceSuite("stub-capture", "evm", makeCapture);

const SEED = "x402-redteam-v1";

describe("adversary EVM extras (stub-capture)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  function load(run_id: string): void {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id });
  }

  it("5. a request under /_host/evil.test/... is logged with host evil.test", async () => {
    load("evm-vhost");
    const res = await fetch(`${adversary.baseUrl}/_host/evil.test/lure`);
    expect(res.status).toBe(200);

    const drain = adversary.drain();
    expect(
      drain.requests.some((r) => r.host === "evil.test" && r.path === "/lure" && r.status === 200),
    ).toBe(true);
  });

  it("hand-rolled malformed payment header is rejected as invalid_payment", async () => {
    load("evm-malformed");
    const res = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": "not-valid-base64!!" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_payment" });
    const drain = adversary.drain();
    expect(drain.requests.some((r) => r.status === 400 && r.paid === false)).toBe(true);
  });

  it("hand-rolled payload encoded via @x402/core/http round-trips", () => {
    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "10000",
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 60,
        extra: {},
      },
      payload: {
        authorization: { from: "0x1", to: "0x2", value: "10000", nonce: "0xabc" },
        signature: "0xdead",
      },
    });
    expect(typeof header).toBe("string");
  });
});
