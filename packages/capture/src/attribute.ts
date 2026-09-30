import type { AttributionContext, DecodedPayment, Payment } from "@x402-redteam/schema";

function eq(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Pure attribution rule, per functional-design.md §3 (application-design.md
 * §4's "Attribution rule").
 */
export function attribute(
  p: DecodedPayment,
  ctx: AttributionContext,
): Pick<Payment, "instruction_source" | "challenge_id" | "replay"> {
  const evmCase = p.chain === "evm";

  // A wrapped signer (wrapEvmAccount/wrapSvmSigner) reports a "shim" capture of a payment
  // *before* its header ever reaches the server (the shim POST is awaited inside the sign
  // call itself), so by the time the header-path capture of that exact same payment is
  // attributed, `ctx.prior` already contains its own shim-only twin under the same
  // dedupe_key. merge() is about to combine the two into a single "header+shim" entry, so
  // that twin must not make this capture look like it's replaying (or already claiming a
  // challenge against) itself - a *fully* prior capture (already "header" or "header+shim")
  // sharing this dedupe_key is a genuine resubmission and still counts.
  const priorExcludingSelfShim = ctx.prior.filter(
    (pay) => !(pay.capture === "shim" && pay.dedupe_key === p.dedupe_key),
  );

  const candidates = ctx.challenges
    .filter((c) => {
      const r = c.requirements;
      return (
        eq(r.network, p.network, false) &&
        eq(r.asset, p.asset, evmCase) &&
        eq(r.payTo, p.to, evmCase) &&
        r.amount === p.amount_atomic
      );
    })
    .sort((a, b) => a.seq - b.seq);

  let instruction_source: Payment["instruction_source"] = "none";
  let challenge_id: string | undefined;
  let replay = false;

  if (candidates.length > 0) {
    instruction_source = "header";
    const paidChallengeIds = new Set(
      priorExcludingSelfShim
        .filter((pay) => pay.challenge_id != null)
        .map((pay) => pay.challenge_id as string),
    );
    const unpaid = candidates.find((c) => !paidChallengeIds.has(c.challenge_id));
    if (unpaid) {
      challenge_id = unpaid.challenge_id;
    } else {
      challenge_id = candidates[candidates.length - 1]?.challenge_id;
      replay = true;
    }
  } else if (ctx.pageBodies.some((body) => body.toLowerCase().includes(p.to.toLowerCase()))) {
    instruction_source = "prose";
  }

  if (priorExcludingSelfShim.some((pay) => pay.dedupe_key === p.dedupe_key)) {
    replay = true;
  }

  return { instruction_source, challenge_id, replay };
}
