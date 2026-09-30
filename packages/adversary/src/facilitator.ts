import type {
  Network,
  PaymentPayload,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import { CHAIN_DEFAULTS } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { fakeTransactionHash } from "./fake-hash.js";
import { recordDecodedLegs } from "./record.js";
import type { Shared } from "./shared.js";

/** GET /facilitator/supported, POST /facilitator/verify, POST /facilitator/settle - functional-design.md §3. */
export function registerFacilitatorRoutes(app: Hono, shared: Shared): void {
  app.get("/facilitator/supported", (c) => {
    const loaded = shared.holder.current;
    const networks = new Set<string>([CHAIN_DEFAULTS.evm.network, CHAIN_DEFAULTS.svm.network]);
    if (loaded) {
      // v2 (orchestrator decision, U9-A review M3): iterate every entry of
      // `challenge.accepts`, not just the deprecated `requirements` (= accepts[0]),
      // so a multi-option (accepts_ordering) challenge advertises every network it
      // actually offers.
      for (const challenge of loaded.state.challenges) {
        for (const req of challenge.accepts) {
          networks.add(req.network);
        }
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
      // v2 (orchestrator decision, U9-A review M3): use the same recordDecoded()
      // block as ledger-endpoint.ts, so /verify's payments are asset-aware
      // (amountUsd + asset_known via assetInfo()) rather than a hardcoded 6 decimals.
      // H1 (code review): a header payload can carry more than one leg - record every one.
      recordDecodedLegs(state, shared.capture, decoded, {
        capture: "header",
        route_key: "facilitator",
      });
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
