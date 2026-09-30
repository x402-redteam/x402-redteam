import type {
  Network,
  PaymentPayload,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { atomicToUsd, CHAIN_DEFAULTS, type Payment } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { fakeTransactionHash } from "./fake-hash.js";
import type { Shared } from "./shared.js";

const AMOUNT_DECIMALS = 6;

/** GET /facilitator/supported, POST /facilitator/verify, POST /facilitator/settle - functional-design.md §3. */
export function registerFacilitatorRoutes(app: Hono, shared: Shared): void {
  app.get("/facilitator/supported", (c) => {
    const loaded = shared.holder.current;
    const networks = new Set<string>([CHAIN_DEFAULTS.evm.network, CHAIN_DEFAULTS.svm.network]);
    if (loaded) {
      for (const challenge of loaded.state.challenges) {
        networks.add(challenge.requirements.network);
      }
    }
    const body: SupportedResponse = {
      kinds: [...networks].map((network) => ({
        x402Version: 2,
        scheme: "exact",
        network: network as Network,
      })),
      extensions: [],
      signers: {},
    };
    return c.json(body);
  });

  app.post("/facilitator/verify", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state } = loaded;
    const body = (await c.req.json().catch(() => null)) as {
      paymentPayload?: PaymentPayload;
    } | null;
    const paymentPayload = body?.paymentPayload;
    if (!paymentPayload) {
      const resp: VerifyResponse = { isValid: false, invalidReason: "invalid_payment" };
      return c.json(resp, 400);
    }
    try {
      const decoded = await shared.capture.decodePayload(paymentPayload, {
        knownOwners: loaded.rendered.knownOwners,
      });
      const attribution = shared.capture.attribute(decoded, {
        challenges: state.challenges,
        pageBodies: state.pageBodies,
        prior: state.payments,
      });
      const seq = state.nextSeq();
      const payment: Payment = {
        payment_id: `p${seq}`,
        seq,
        capture: "header",
        chain: state.chain,
        network: decoded.network,
        scheme: decoded.scheme,
        asset: decoded.asset,
        from: decoded.from,
        to: decoded.to,
        amount_atomic: decoded.amount_atomic,
        amount_usd: atomicToUsd(decoded.amount_atomic, AMOUNT_DECIMALS),
        route_key: "facilitator",
        dedupe_key: decoded.dedupe_key,
        instruction_source: attribution.instruction_source,
        challenge_id: attribution.challenge_id,
        replay: attribution.replay,
        valid: decoded.valid,
        raw: decoded.raw,
      };
      state.payments = shared.capture.merge(state.payments, payment);
      const resp: VerifyResponse = decoded.valid
        ? { isValid: true, payer: decoded.from }
        : {
            isValid: false,
            invalidReason: decoded.invalid_reason ?? "invalid_signature",
            payer: decoded.from,
          };
      return c.json(resp);
    } catch {
      const resp: VerifyResponse = { isValid: false, invalidReason: "invalid_payment" };
      return c.json(resp, 400);
    }
  });

  app.post("/facilitator/settle", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state } = loaded;
    const body = (await c.req.json().catch(() => null)) as {
      paymentPayload?: PaymentPayload;
    } | null;
    const paymentPayload = body?.paymentPayload;
    const fallbackNetwork = CHAIN_DEFAULTS[state.chain].network as Network;
    if (!paymentPayload) {
      const resp: SettleResponse = {
        success: false,
        errorReason: "invalid_payment",
        transaction: "",
        network: fallbackNetwork,
      };
      return c.json(resp, 400);
    }
    try {
      const decoded = await shared.capture.decodePayload(paymentPayload, {
        knownOwners: loaded.rendered.knownOwners,
      });
      const seq = state.nextSeq();
      const resp: SettleResponse = {
        success: true,
        transaction: fakeTransactionHash(state.chain, state.run_id, seq),
        network: decoded.network as Network,
        payer: decoded.from,
      };
      return c.json(resp);
    } catch {
      const resp: SettleResponse = {
        success: false,
        errorReason: "invalid_payment",
        transaction: "",
        network: fallbackNetwork,
      };
      return c.json(resp, 400);
    }
  });
}
