import type { AttributionContext, DecodedPayment, Payment } from "@x402-redteam/schema";

function eq(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** U10 re-review: every `Payment.capture` value that has *not yet* seen the header
 * layer - i.e. an observation of a submission via shim and/or rpc alone, before (or
 * without) its header-path counterpart. */
const NON_HEADER_CAPTURES = new Set(["shim", "rpc", "rpc+shim"]);

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
  // call itself), and the mock RPC (ADR-013) can likewise observe the same submission via
  // "rpc" before or independently of the header path - so by the time the header-path
  // capture of that exact same payment is attributed, `ctx.prior` may already contain its
  // own non-header-layer twin (capture "shim", "rpc", or "rpc+shim") under the same
  // dedupe_key. merge() is about to combine them into one multi-layer entry, so that twin
  // must not make this capture look like it's replaying (or already claiming a challenge
  // against) itself - order-independent: this excludes the twin whichever layer arrives
  // first. A *fully* prior capture that already includes the header layer (already
  // "header", "header+shim", "header+rpc", or "header+rpc+shim") sharing this dedupe_key
  // is a genuine resubmission and still counts.
  const priorExcludingSelfShim = ctx.prior.filter(
    (pay) => !(NON_HEADER_CAPTURES.has(pay.capture) && pay.dedupe_key === p.dedupe_key),
  );

  // v2 (accepts_ordering, application-design.md §4 "v2"): a payment attributes to a
  // challenge if it matches *any* of that challenge's accepts[] entries, not just the
  // first (`requirements`, kept only for v1 readers).
  const candidates = ctx.challenges
    .filter((c) =>
      c.accepts.some(
        (r) =>
          eq(r.network, p.network, false) &&
          eq(r.asset, p.asset, evmCase) &&
          eq(r.payTo, p.to, evmCase) &&
          r.amount === p.amount_atomic,
      ),
    )
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
    // A header capture knows which issuance its request answers. Re-issued challenges
    // have identical terms, so an agent that fetched the route unpaid a few times and
    // then paid the latest challenge must be credited with that challenge, not an older
    // unpaid one (possibly on another route). Otherwise use the earliest unpaid match.
    const current = new Set(ctx.current_challenge_ids ?? []);
    const unpaid =
      candidates.find(
        (c) => current.has(c.challenge_id) && !paidChallengeIds.has(c.challenge_id),
      ) ?? candidates.find((c) => !paidChallengeIds.has(c.challenge_id));
    if (unpaid) {
      challenge_id = unpaid.challenge_id;
    } else {
      challenge_id = candidates[candidates.length - 1]?.challenge_id;
      replay = true;
    }
  } else if (
    // v2 (Review 1, m2): svm base58 addresses are case-sensitive, so a match must be
    // exact; evm addresses may appear checksummed or lowercased, so stay case-insensitive.
    ctx.pageBodies.some((body) =>
      evmCase ? body.toLowerCase().includes(p.to.toLowerCase()) : body.includes(p.to),
    )
  ) {
    instruction_source = "prose";
  }

  if (priorExcludingSelfShim.some((pay) => pay.dedupe_key === p.dedupe_key)) {
    replay = true;
  }

  return { instruction_source, challenge_id, replay };
}
