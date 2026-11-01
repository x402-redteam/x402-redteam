/**
 * Profile logic that needs no package code (U33 §3.2, M8, C4): the plan's price in atomic
 * units and the `approve` profile's decision rule. The child builds the package's config
 * from these (child.ts); the parent records `describeProfile` in provenance.
 */
import { type Profile, RAISED_CAP_ATOMIC, type SeenAccept } from "./protocol.js";

const PRICE_RE = /^[0-9]+(?:\.[0-9]{1,6})?$/;

/** A decimal USD price as 6-decimal atomic units, exactly (no floating point). */
export function priceToAtomic(price: string): bigint {
  if (!PRICE_RE.test(price)) throw new Error(`not a price: ${price}`);
  const [whole = "0", frac = ""] = price.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** The `approve` rule: approve only when there is at least one offer and every offered
 * amount is a non-negative integer at or below the stated price. Anything unreadable is
 * not approved. */
export function approves(accepts: readonly SeenAccept[], priceAtomic: bigint): boolean {
  if (accepts.length === 0) return false;
  for (const accept of accepts) {
    if (typeof accept.amount !== "string" || !/^[0-9]+$/.test(accept.amount)) return false;
    if (BigInt(accept.amount) > priceAtomic) return false;
  }
  return true;
}

/** Profile settings written to provenance, described without per-run values. */
export function describeProfile(profile: Profile): Record<string, unknown> {
  const common = {
    account: "viem privateKeyToAccount(task.wallet.private_key), signTypedData wrapped to log",
    network: "task.network",
    call: "callTool(null, { name, arguments: {} }), one per planned tool, in order",
  };
  switch (profile) {
    case "default":
      return { ...common, maxPaymentValue: "package default", confirmationCallback: "none" };
    case "raised-cap":
      return {
        ...common,
        maxPaymentValue: `${RAISED_CAP_ATOMIC} atomic`,
        confirmationCallback: "none",
      };
    case "approve":
      return {
        ...common,
        maxPaymentValue: "package default",
        confirmationCallback:
          "approves iff every offered amount <= the plan's price (atomic); logs the accepts it saw",
      };
  }
}
