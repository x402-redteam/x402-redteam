import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary, type DrainedRun } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";
import { makeCapture } from "./stub-capture.js";

const SEED = "x402-redteam-v1";

/**
 * Determinism (acceptance item 8) is a property of the adversary's own logic
 * (seq assignment, challenge_id counters, requirements construction), not of
 * whatever a real signing client happens to produce - the real EVM/SVM
 * clients embed wall-clock timestamps and random nonces, so two runs driven
 * through them are never byte-identical. To isolate the property this test
 * is actually about, we drive both sequences with a fixed, hand-encoded
 * payment header (built once, reused verbatim) instead of a fresh signature.
 */
describe("adversary determinism", () => {
  let adversary: Adversary;

  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture: makeCapture() });
  });

  afterAll(async () => {
    await adversary.close();
  });

  async function runSequence(): Promise<DrainedRun> {
    adversary.load({ scenario: buildFixtureScenario(), chain: "evm", run_id: "det-run" });

    await fetch(`${adversary.baseUrl}/free`);
    await fetch(`${adversary.baseUrl}/_host/evil.test/lure`);

    const unpaid = await fetch(`${adversary.baseUrl}/normal`);
    const paymentRequired = (await unpaid.json()) as { accepts: PaymentRequirements[] };
    const requirements = paymentRequired.accepts[0] as PaymentRequirements;

    const header = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted: requirements,
      payload: {
        authorization: {
          from: "0xaaaa000000000000000000000000000000000a",
          to: requirements.payTo,
          value: requirements.amount,
          validAfter: "0",
          validBefore: "9999999999",
          nonce: "0xfixed000000000000000000000000000000000000000000000000000000f0",
        },
        signature: "0xdeadbeef",
      },
    });
    await fetch(`${adversary.baseUrl}/normal`, { headers: { "PAYMENT-SIGNATURE": header } });

    return adversary.drain();
  }

  /**
   * U11: `authorization_seconds` (computeAuthorizationSeconds, routes.ts) is
   * deliberately derived from the real receipt wall-clock time (`Date.now()`), per the
   * orchestrator's approved formula `validBefore - max(validAfter, receiptTimeSeconds)`
   * (audit.md, U9-B integration decision) - `validAfter` is always `"0"` on the wire, so
   * using the literal value would report a window dominated by epoch time instead of the
   * real authorization lifetime. That makes it the one field on a payment that is
   * *intentionally* not reproducible run-to-run (application-design.md §4 "v2": it's
   * stripped from report.json for exactly this reason). This redacts it before
   * comparing, the same way the CLI's own e2e determinism tests redact signing
   * randomness (`dedupe_key`/`raw`) - this test's job is the adversary's own logic
   * (seq assignment, challenge_id counters, requirements construction), not wall-clock
   * behaviour.
   */
  function redactAuthorizationSeconds(drain: DrainedRun): DrainedRun {
    return {
      ...drain,
      payments: drain.payments.map((p) => ({ ...p, authorization_seconds: undefined })),
    };
  }

  it("gives deep-equal drains across two identical load-run-drain sequences", async () => {
    const first = await runSequence();
    const second = await runSequence();
    expect(redactAuthorizationSeconds(second)).toEqual(redactAuthorizationSeconds(first));
  });
});
