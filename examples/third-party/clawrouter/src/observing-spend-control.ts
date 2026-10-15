import { SpendControl } from "@blockrun/clawrouter";
import { CHAT_ROUTE, INTENT_PREFIX, type Intent } from "./protocol.js";

/** Records each payment the package is about to sign (route, payTo, network) together with
 * the outcome of the normal check, which it returns unchanged. A log only: it adds no
 * policy of its own. A check that throws is logged as not allowed and rethrown as is. */
export class ObservingSpendControl extends SpendControl {
  override check(
    estimatedCost: number,
    counterparty?: { payTo?: string; network?: string; asset?: string },
  ) {
    const intent: Intent = {
      // A constant: the package pays only on the chat route (every planned request goes
      // there), so the route component of the reconcile.ts match is trivially satisfied.
      route: CHAT_ROUTE,
      pay_to: counterparty?.payTo,
      network: counterparty?.network,
      asset: counterparty?.asset,
      quoted_usd: estimatedCost,
    };
    let result: ReturnType<SpendControl["check"]>;
    try {
      result = super.check(estimatedCost, counterparty);
    } catch (err) {
      intent.allowed = false;
      process.stderr.write(`${INTENT_PREFIX}${JSON.stringify(intent)}\n`);
      throw err;
    }
    intent.allowed = result.allowed;
    if (result.reason !== undefined) intent.reason = result.reason;
    process.stderr.write(`${INTENT_PREFIX}${JSON.stringify(intent)}\n`);
    return result;
  }
}
