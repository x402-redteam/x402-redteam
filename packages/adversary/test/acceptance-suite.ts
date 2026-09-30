import { createKeyPairSignerFromBytes, getBase58Encoder } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { Network } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { agentWallet, type CaptureApi, CHAIN_DEFAULTS, type Chain } from "@x402-redteam/schema";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Adversary, createAdversary } from "../src/index.js";
import { buildFixtureScenario } from "./fixtures/scenario.js";

const SEED = "x402-redteam-v1";

/**
 * Builds a real `x402Client` for the given chain, driven by the same
 * deterministic agent wallet the harness would hand an agent under test.
 *
 * DEVIATION from the spec's literal `registerExactSvmScheme`: the real
 * @x402/svm@2.28.0 `registerExactSvmScheme` never forwards its config's
 * `rpcUrl` to the `ExactSvmScheme` it constructs (`dist/esm/exact/client/
 * index.mjs`: `new ExactSvmScheme(config.signer)`, config dropped) - so a
 * client built through it always falls back to the real Solana devnet
 * endpoint, which would break "no network". We register the scheme
 * directly instead - `client.register(network, new ExactSvmScheme(signer,
 * { rpcUrl }))` - exactly the pattern @x402/fetch's own README documents
 * for manual scheme registration. It is still the real, unmodified
 * `ExactSvmScheme` class from `@x402/svm`.
 */
async function makeClientForChain(chain: Chain, baseUrl: string) {
  if (chain === "evm") {
    const wallet = agentWallet(SEED, "evm");
    const account = privateKeyToAccount(wallet.secret as `0x${string}`);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: account });
    return client;
  }
  const wallet = agentWallet(SEED, "svm");
  const signer = await createKeyPairSignerFromBytes(getBase58Encoder().encode(wallet.secret));
  const client = new x402Client();
  client.register(
    CHAIN_DEFAULTS.svm.network as Network,
    new ExactSvmScheme(signer, { rpcUrl: `${baseUrl}/solana-rpc` }),
  );
  return client;
}

/**
 * The acceptance suite from functional-design.md §4 (items 1-4 and 6),
 * parametrized over chain and `CaptureApi` implementation so the exact same
 * assertions run against both the test stub and (at Gate G2) the real
 * `@x402-redteam/capture` package - see `test/stub-capture.ts` and
 * `test/real-capture.test.ts`.
 */
export function defineAcceptanceSuite(
  label: string,
  chain: Chain,
  makeCaptureInstance: () => CaptureApi,
): void {
  describe(`adversary ${chain.toUpperCase()} acceptance (${label})`, () => {
    let adversary: Adversary;

    beforeAll(async () => {
      adversary = await createAdversary({ seed: SEED, capture: makeCaptureInstance() });
    });

    afterAll(async () => {
      await adversary.close();
    });

    function load(run_id: string): void {
      adversary.load({
        scenario: buildFixtureScenario(),
        chain,
        run_id: `${chain}-${label}-${run_id}`,
      });
    }

    it("1. pays the normal route and delivers", async () => {
      load("normal");
      const client = await makeClientForChain(chain, adversary.baseUrl);
      const fetchWithPay = wrapFetchWithPayment(fetch, client);
      const res = await fetchWithPay(`${adversary.baseUrl}/normal`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("normal-delivered");

      const drain = adversary.drain();
      const routeKey = "provider.test/normal";
      expect(drain.challenges.filter((c) => c.route_key === routeKey)).toHaveLength(1);
      const payments = drain.payments.filter((p) => p.route_key === routeKey);
      expect(payments).toHaveLength(1);
      expect(payments[0]?.capture).toBe("header");
      expect(payments[0]?.valid).toBe(true);
      expect(drain.delivered).toBe(true);
    });

    it("2. 402_forever ends in a 402 with >=1 payment and >=2 challenges", async () => {
      load("forever");
      const client = await makeClientForChain(chain, adversary.baseUrl);
      const fetchWithPay = wrapFetchWithPayment(fetch, client);
      const res = await fetchWithPay(`${adversary.baseUrl}/forever`);
      expect(res.status).toBe(402);

      const drain = adversary.drain();
      const routeKey = "provider.test/forever";
      expect(drain.payments.filter((p) => p.route_key === routeKey).length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        drain.challenges.filter((c) => c.route_key === routeKey).length,
      ).toBeGreaterThanOrEqual(2);
    });

    it("3. no_delivery leaves delivered=false", async () => {
      load("nodelivery");
      const client = await makeClientForChain(chain, adversary.baseUrl);
      const fetchWithPay = wrapFetchWithPayment(fetch, client);
      const res = await fetchWithPay(`${adversary.baseUrl}/nodelivery`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");

      const drain = adversary.drain();
      expect(drain.delivered).toBe(false);
    });

    it("4. replay: first paid GET delivers, later requests get an identical 402, replaying the same header flags replay", async () => {
      load("replay");
      const client = await makeClientForChain(chain, adversary.baseUrl);
      const httpClient = new x402HTTPClient(client);
      const routeKey = "provider.test/replay";

      const unpaid1 = await fetch(`${adversary.baseUrl}/replay`);
      expect(unpaid1.status).toBe(402);
      const paymentRequired1 = httpClient.getPaymentRequiredResponse((name) =>
        unpaid1.headers.get(name),
      );

      // First paid attempt: fresh signature against the first-issued challenge. Delivers.
      const paymentPayload1 = await httpClient.createPaymentPayload(paymentRequired1);
      const headers1 = httpClient.encodePaymentSignatureHeader(paymentPayload1);
      const paid1 = await fetch(`${adversary.baseUrl}/replay`, { headers: headers1 });
      expect(paid1.status).toBe(200);
      expect(await paid1.text()).toBe("replay-delivered");

      // Second paid attempt: a genuinely fresh signature (different nonce/dedupe_key) against
      // the SAME requirements, submitted with no intervening unpaid GET so the first challenge
      // is the only candidate and it is already claimed - attribution must flag this as a
      // replay (application-design.md §4 "earliest unpaid match, else replay") rather than a
      // new payment, and the route must re-lock into a 402 instead of delivering again.
      const paymentPayload2 = await httpClient.createPaymentPayload(paymentRequired1);
      const headers2 = httpClient.encodePaymentSignatureHeader(paymentPayload2);
      const paid2 = await fetch(`${adversary.baseUrl}/replay`, { headers: headers2 });
      expect(paid2.status).toBe(402);

      // A later plain GET still gets the byte-identical challenge.
      const unpaid2 = await fetch(`${adversary.baseUrl}/replay`);
      expect(unpaid2.status).toBe(402);
      const paymentRequired2 = httpClient.getPaymentRequiredResponse((name) =>
        unpaid2.headers.get(name),
      );
      expect(paymentRequired2.accepts[0]).toEqual(paymentRequired1.accepts[0]);

      const drain = adversary.drain();
      const replayChallenges = drain.challenges.filter((c) => c.route_key === routeKey);
      expect(replayChallenges.length).toBeGreaterThanOrEqual(2);
      for (const challenge of replayChallenges) {
        expect(challenge.requirements).toEqual(replayChallenges[0]?.requirements);
      }

      const payments = drain.payments.filter((p) => p.route_key === routeKey);
      expect(payments).toHaveLength(2);
      expect(payments[0]?.replay).toBe(false);
      expect(payments[1]?.replay).toBe(true);
      expect(payments[1]?.dedupe_key).not.toBe(payments[0]?.dedupe_key);
    });

    it("6. facilitator endpoints return the expected shapes", async () => {
      load("facilitator");

      const supported = await fetch(`${adversary.baseUrl}/facilitator/supported`);
      expect(supported.status).toBe(200);
      // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
      const supportedBody = (await supported.json()) as any;
      expect(supportedBody.kinds.some((k: { scheme: string }) => k.scheme === "exact")).toBe(true);

      const client = await makeClientForChain(chain, adversary.baseUrl);
      const httpClient = new x402HTTPClient(client);
      const unpaid = await fetch(`${adversary.baseUrl}/normal`);
      const paymentRequired = httpClient.getPaymentRequiredResponse((name) =>
        unpaid.headers.get(name),
      );
      const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

      const verify = await fetch(`${adversary.baseUrl}/facilitator/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: paymentRequired.accepts[0],
        }),
      });
      expect(verify.status).toBe(200);
      // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
      const verifyBody = (await verify.json()) as any;
      expect(verifyBody.isValid).toBe(true);

      const settle = await fetch(`${adversary.baseUrl}/facilitator/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          x402Version: 2,
          paymentPayload,
          paymentRequirements: paymentRequired.accepts[0],
        }),
      });
      expect(settle.status).toBe(200);
      // biome-ignore lint/suspicious/noExplicitAny: test-only response body inspection
      const settleBody = (await settle.json()) as any;
      expect(settleBody.success).toBe(true);
    });
  });
}
