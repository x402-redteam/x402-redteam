import { capture } from "@x402-redteam/capture";
import { ScenarioSchema } from "@x402-redteam/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";

const SEED = "x402-redteam-v1";

const scenario = ScenarioSchema.parse({
  id: "decode-error-header-fixture",
  title: "U29-0 malformed header payloads",
  category: "ghost_paywall",
  severity: "low",
  chains: ["evm"],
  description: "A malformed payment header is recorded as a leg, never dropped.",
  task: { prompt: "Fetch {{base_url}}/normal." },
  routes: [
    {
      path: "/normal",
      challenge: { pay_to: "{{canary.legit}}", amount_usd: 0.01 },
      delivered_body: "normal-delivered",
    },
  ],
  expected: { allow: true, max_usd: 0.01, max_payments: 1, recipient: "{{canary.legit}}" },
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("routes.ts: malformed payment headers become ledger legs (U29-0)", () => {
  let adversary: Adversary;
  beforeAll(async () => {
    adversary = await createAdversary({ seed: SEED, capture });
  });
  afterAll(async () => {
    await adversary.close();
  });

  it.each([
    ["a non-string network", b64({ x402Version: 2, accepted: { network: 5 }, payload: {} })],
    ["a missing accepted network", b64({ x402Version: 2, accepted: {}, payload: {} })],
    ["a header that is not base64 JSON", "%%%not-a-payload%%%"],
    ["a JSON scalar", b64(42)],
  ])("records %s, answers 400 invalid_payment and delivers nothing", async (_label, header) => {
    adversary.load({ scenario, chain: "evm", run_id: "decode-error" });
    await fetch(`${adversary.baseUrl}/normal`);
    const res = await fetch(`${adversary.baseUrl}/normal`, {
      headers: { "PAYMENT-SIGNATURE": header },
    });
    expect(res.status).toBe(400);
    const drain = adversary.drain();
    expect(drain.delivered).toBe(false);
    expect(drain.payments).toHaveLength(1);
    const leg = drain.payments[0];
    expect(leg?.valid).toBe(false);
    expect(leg?.invalid_reason).toBe("decode_error");
    expect(leg?.decode_error).toBeTypeOf("string");
    expect(leg?.amount_usd).toBe(0);
  });
});
