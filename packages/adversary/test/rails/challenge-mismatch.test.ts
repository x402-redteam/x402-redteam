import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { Network, PaymentPayload } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { capture } from "@x402-redteam/capture";
import { agentWallet, CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../../src/index.js";
import { buildFixtureScenario } from "../fixtures/scenario.js";
import { makeCapture } from "../stub-capture.js";

const SEED = "x402-redteam-v1";

/**
 * ADR-014 §3 binding check (U20 code review fix 2): the check compares the
 * credential's *echoed* `accepted` - the wire `PaymentRequirements` the client claims
 * it's paying - field-by-field against what this issuance actually offered. Tampering
 * `accepted.payTo` to an address that was never issued (while the authorization itself
 * still legitimately signs over *that same* wrong `to`, so this is also a genuine
 * attribution non-match, not just a wire inconsistency) gets `binding_mismatch: true`,
 * without ever setting `invalid_reason` or flipping `valid` (orchestrator ruling, fix 3)
 * - the route still never delivers, exactly as it wouldn't have before this rail port.
 */
function mismatchedPayload(wrongTo: string): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      payTo: wrongTo,
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

  it("flags a credential whose echoed accepted.payTo was never issued, and never delivers", async () => {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "evm",
      run_id: "challenge-mismatch",
    });
    const payTo = await normalRoutePayTo(adversary.baseUrl);
    const attacker = "0x2222222222222222222222222222222222222B";
    expect(attacker.toLowerCase()).not.toBe(payTo.toLowerCase());

    const header = encodePaymentSignatureHeader(mismatchedPayload(attacker));
    const res = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "invalid_payment" });

    const drain = adversary.drain();
    expect(drain.delivered).toBe(false);
    const payment = drain.payments.find((p) => p.dedupe_key === "test-challenge-mismatch");
    expect(payment).toBeDefined();
    // Orchestrator ruling (fix 3): a mismatch never implies invalid/not-valid.
    expect(payment?.valid).toBe(true);
    expect(payment?.invalid_reason).toBeUndefined();
    expect(payment?.binding_mismatch).toBe(true);
    expect(payment?.challenge_id).toBeUndefined();
  });

  it("does not let a binding mismatch override a decoder-level invalid_reason", async () => {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "evm",
      run_id: "challenge-mismatch-bad-sig",
    });
    await normalRoutePayTo(adversary.baseUrl);
    const attacker = "0x2222222222222222222222222222222222222B";
    const payload = mismatchedPayload(attacker);
    // stub-capture.ts: this exact sentinel nonce always decodes as `valid: false,
    // invalid_reason: "bad_signature"`, regardless of the mismatched `accepted.payTo`.
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
    // binding_mismatch is still recorded (it's an independent fact about the wire echo)
    // - it just never *overrides* the more specific decoder reason.
    expect(payment?.binding_mismatch).toBe(true);
  });
});

/**
 * U20 code review fix 1: the real svm decoder always returns `DecodedPayment.legs`
 * (verified in `packages/capture/src/svm.ts`), so a binding-mismatch flag applied only
 * to the un-recorded top-level `DecodedPayment` would never reach the actually-recorded
 * `Payment`. Drives a REAL, correctly-signed SVM transaction (via the real
 * `@x402-redteam/capture` package and `ExactSvmScheme`, same pattern as
 * `real-capture.test.ts`) through the adversary, with `accepted.payTo` tampered to an
 * address nothing was issued to - proving `binding_mismatch` lands on the recorded leg.
 */
describe("challenge_mismatch via the real SVM decoder (code review fix 1)", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });

  afterAll(async () => {
    await adversary.close();
  });

  it("flags binding_mismatch on the recorded leg, without changing delivery", async () => {
    adversary.load({
      scenario: buildFixtureScenario(),
      chain: "svm",
      run_id: "challenge-mismatch-svm-real",
    });

    const wallet = agentWallet(SEED, "svm");
    const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
    const client = new x402Client();
    client.register(
      CHAIN_DEFAULTS.svm.network as Network,
      new ExactSvmScheme(signer, { rpcUrl: `${adversary.baseUrl}/solana-rpc` }),
    );
    const httpClient = new x402HTTPClient(client);

    const unpaid = await fetch(`${adversary.baseUrl}/normal`);
    expect(unpaid.status).toBe(402);
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
      unpaid.headers.get(name),
    );
    // A real, correctly-signed transaction paying the real, issued recipient/amount.
    const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

    // Tamper the wire echo only - the signed transaction inside `payload` still really
    // pays the real recipient. This is exactly the "wire claim disagrees with what was
    // issued" case the binding check exists for, independent of the transaction's own
    // (genuine) validity.
    const tampered = {
      ...paymentPayload,
      accepted: { ...paymentPayload.accepted, payTo: "11111111111111111111111111111111" },
    };
    const headers = httpClient.encodePaymentSignatureHeader(tampered);
    const res = await fetch(`${adversary.baseUrl}/normal`, { headers });

    const drain = adversary.drain();
    const payment = drain.payments.find((p) => p.route_key === "provider.test/normal");
    expect(payment).toBeDefined();
    expect(payment?.valid).toBe(true);
    expect(payment?.binding_mismatch).toBe(true);
    // Delivery is unaffected: attribution still matches on the transaction's real,
    // decoded terms (routes.ts/attribute.ts), which the tamper never touched.
    expect(res.status).toBe(200);
    expect(drain.delivered).toBe(true);
    expect(payment?.challenge_id).toBeDefined();
  });
});
