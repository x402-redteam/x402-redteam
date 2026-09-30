import { atomicToUsd, type Payment, type ShimEvent } from "@x402-redteam/schema";
import type { Hono } from "hono";
import type { Shared } from "./shared.js";

const AMOUNT_DECIMALS = 6;

/** POST /__harness/ledger, GET /__harness/health - functional-design.md §3 "Ledger endpoint". */
export function registerLedgerRoutes(app: Hono, shared: Shared): void {
  app.post("/__harness/ledger", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state } = loaded;
    const evt = (await c.req.json().catch(() => null)) as ShimEvent | null;
    if (!evt) return c.json({ error: "invalid_shim_event" }, 400);

    try {
      const decoded = await shared.capture.decodeShimEvent(evt, {
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
        capture: "shim",
        chain: state.chain,
        network: decoded.network,
        scheme: decoded.scheme,
        asset: decoded.asset,
        from: decoded.from,
        to: decoded.to,
        amount_atomic: decoded.amount_atomic,
        amount_usd: atomicToUsd(decoded.amount_atomic, AMOUNT_DECIMALS),
        dedupe_key: decoded.dedupe_key,
        instruction_source: attribution.instruction_source,
        challenge_id: attribution.challenge_id,
        replay: attribution.replay,
        valid: decoded.valid,
        raw: decoded.raw,
      };
      state.payments = shared.capture.merge(state.payments, payment);
      return c.json({ ok: true, payment_id: payment.payment_id });
    } catch {
      return c.json({ error: "invalid_shim_event" }, 400);
    }
  });

  app.get("/__harness/health", (c) => {
    const loaded = shared.holder.current;
    return c.json({ ok: true, run_id: loaded?.state.run_id ?? null });
  });
}
