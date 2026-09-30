import type { ShimEvent } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { recordDecoded } from "./record.js";
import type { Shared } from "./shared.js";

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
      const payment = recordDecoded(state, shared.capture, decoded, { capture: "shim" });
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
