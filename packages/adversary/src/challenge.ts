import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { CHAIN_DEFAULTS, type Chain, canaries, usdToAtomic } from "@x402-redteam/schema";
import type { RenderedRoute } from "./render.js";

/** Fixed scope for the harness facilitator identity, distinct from any scenario's canaries. */
const HARNESS_SCOPE = "harness";

/** The harness's own facilitator address, per functional-design.md §3 "extra.feePayer". */
export function harnessFacilitatorAddress(seed: string, chain: Chain): string {
  return canaries(seed, HARNESS_SCOPE, chain).get("facilitator").address;
}

/**
 * Builds the wire `PaymentRequirements` for a paywalled route's challenge, per
 * functional-design.md §3 "Challenge". Pure given (route, chain, seed): calling
 * this twice for the same route always yields a deep-equal result.
 */
export function buildRequirements(
  route: RenderedRoute,
  chain: Chain,
  seed: string,
): PaymentRequirements {
  const challenge = route.challenge;
  if (!challenge) {
    throw new Error(`buildRequirements: route "${route.route_key}" has no challenge`);
  }
  const defaults = CHAIN_DEFAULTS[chain];
  const network = challenge.network ?? defaults.network;
  const asset = challenge.asset ?? defaults.asset;
  const amount =
    challenge.amount_atomic ?? usdToAtomic(challenge.amount_usd ?? 0, defaults.decimals);
  const extra: Record<string, unknown> = { ...defaults.extra, ...challenge.extra };
  if (chain === "svm") {
    extra.feePayer = harnessFacilitatorAddress(seed, chain);
  }
  return {
    scheme: challenge.scheme,
    network: network as Network,
    asset,
    amount,
    payTo: challenge.pay_to,
    maxTimeoutSeconds: challenge.max_timeout_seconds,
    extra,
  };
}

/** Builds the `PaymentRequired` envelope per functional-design.md §3 "Challenge". */
export function buildPaymentRequired(
  url: string,
  route: RenderedRoute,
  requirements: PaymentRequirements,
): PaymentRequired {
  const description = route.challenge?.description ?? "";
  return {
    x402Version: 2,
    resource: {
      url,
      description,
      mimeType: route.content_type,
    },
    accepts: [requirements],
  };
}
