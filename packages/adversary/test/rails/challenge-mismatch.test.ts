import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../../src/index.js";
import { buildFixtureScenario } from "../fixtures/scenario.js";
import { makeCapture } from "../stub-capture.js";

const SEED = "x402-redteam-v1";

/**
 * ADR-014 §3 binding check (U20): a credential that decodes validly but doesn't match
 * what the currently-issued challenge actually offered - here, a different `to` than
 * the issued `payTo`, as an attacker-redirected payment would look - gets the
 * diagnostic `invalid_reason: "challenge_mismatch"`, without changing the outcome the
 * harness already had: the leg doesn't attribute to any challenge (stub-capture's
 * `attribute()` matches on `payTo` + `amount`, same as the real capture package's own
 * `accepts[]` match), so the route never delivers - exactly as it wouldn't have before
 * this rail port, just without a reason code attached.
 */
function mismatchedPayload(payTo: string, wrongTo: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: {
      authorization: {
        from: "0x1111111111111111111111111111111111111A",
        to: wrongTo,
        value: "10000",
        nonce: "test-challenge-mismatch",
      },
    },
  } as PaymentPayload;
}

async function normalRoutePayTo(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/normal`);
  const body = (await res.json()) as { accepts: Array<{ payTo: string }> };
  const payTo = body.accepts[0]?.payTo;
  if (!payTo) throw new Error("normalRoutePayTo: no accepts[0].payTo in /normal's 402 body");
  return payTo;
}

describe("challenge_mismatch (ADR-014 §3 binding check)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("flags a credential paid to a different address than issued, and never delivers", async () => {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "evm",
      run_id: "challenge-mismatch",
    });
    const payTo = await normalRoutePayTo(adversary.baseUrl);
    const attacker = "0x2222222222222222222222222222222222222B";
    expect(attacker.toLowerCase()).not.toBe(payTo.toLowerCase());

    const header = encodePaymentSignatureHeader(mismatchedPayload(payTo, attacker));
    const res = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "invalid_payment" });

    const drain = adversary.drain();
    expect(drain.delivered).toBe(false);
    const payment = drain.payments.find((p) => p.dedupe_key === "test-challenge-mismatch");
    expect(payment).toBeDefined();
    expect(payment?.valid).toBe(true);
    expect(payment?.invalid_reason).toBe("challenge_mismatch");
    expect(payment?.challenge_id).toBeUndefined();
  });

  it("does not override a decoder-level invalid_reason with challenge_mismatch", async () => {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "evm",
      run_id: "challenge-mismatch-bad-sig",
    });
    const payTo = await normalRoutePayTo(adversary.baseUrl);
    const attacker = "0x2222222222222222222222222222222222222B";
    const payload = mismatchedPayload(payTo, attacker);
    // stub-capture.ts: this exact sentinel nonce always decodes as `valid: false,
    // invalid_reason: "bad_signature"`, regardless of the mismatched `to`.
    (payload.payload as { authorization: { nonce: string } }).authorization.nonce =
      "test-invalid-signature";
    const header = encodePaymentSignatureHeader(payload);
    const res = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });

    expect(res.status).toBe(402);
    const drain = adversary.drain();
    const payment = drain.payments.find((p) => p.dedupe_key === "test-invalid-signature");
    expect(payment?.valid).toBe(false);
    expect(payment?.invalid_reason).toBe("bad_signature");
  });
});
