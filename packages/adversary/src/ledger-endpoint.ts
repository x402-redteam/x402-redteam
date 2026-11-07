import type { ShimEvent } from "@x402-redteam/schema";
import type { Hono } from "hono";
import { knownTokenAccountsFor } from "./known-token-accounts.js";
import { noteLimit, readJson, shimTxTooBig, typedDataTooBig } from "./limits.js";
import { recordDecodedLegs } from "./record.js";
import type { Shared } from "./shared.js";

/** POST /__harness/ledger, GET /__harness/health - functional-design.md §3 "Ledger endpoint". */
export function registerLedgerRoutes(app: Hono, shared: Shared): void {
  app.post("/__harness/ledger", async (c) => {
    const loaded = shared.holder.current;
    if (!loaded) return c.json({ error: "no_run_loaded" }, 409);
    const { state, rendered } = loaded;
    const evt = (await readJson(c, state, "ledger")) as ShimEvent | null;
    if (!evt) return c.json({ error: "invalid_shim_event" }, 400);
    // U38: agent-supplied EIP-712 `types` decode super-linearly; refuse oversized typed data
    // before capture sees it.
    if (
      evt.kind === "evm_typed_data" &&
      typeof evt.payload === "object" &&
      evt.payload !== null &&
      typedDataTooBig(evt.payload)
    ) {
      noteLimit(state, "field_bytes", "ledger");
      return c.json({ error: "invalid_shim_event" }, 400);
    }

    // U38 (M1): the same transaction bounds as the RPC routes.
    if (shimTxTooBig(state, evt, "ledger")) return c.json({ error: "invalid_shim_event" }, 400);
    try {
      const hints = {
        knownOwners: rendered.knownOwners,
        knownTokenAccounts: await knownTokenAccountsFor(
          rendered,
          state.chain,
          shared.seed,
          state.scenario.assets,
        ),
      };
      const decoded = await shared.gate.run(state, "ledger", () =>
        shared.capture.decodeShimEvent(evt, hints),
      );
      // H1 (code review): a single shim-reported event can carry more than one leg
      // (see DecodedPayment.legs) - record every one.
      const payments = recordDecodedLegs(state, shared.capture, decoded, { capture: "shim" });
      return c.json({ ok: true, payment_id: payments[0]?.payment_id });
    } catch {
      return c.json({ error: "invalid_shim_event" }, 400);
    }
  });

  app.get("/__harness/health", (c) => {
    const loaded = shared.holder.current;
    return c.json({ ok: true, run_id: loaded?.state.run_id ?? null });
  });
}
