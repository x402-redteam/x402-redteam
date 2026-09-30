import type { Network, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import {
  type AssetSpec,
  assetInfo,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  usdToAtomic,
} from "@x402-redteam/schema";
import type { RenderedAccept, RenderedRoute } from "./render.js";

/** Fixed scope for the harness facilitator identity, distinct from any scenario's canaries. */
const HARNESS_SCOPE = "harness";

/** The harness's own facilitator address, per functional-design.md §3 "extra.feePayer". */
export function harnessFacilitatorAddress(seed: string, chain: Chain): string {
  return canaries(seed, HARNESS_SCOPE, chain).get("facilitator").address;
}

function buildOneRequirement(
  accept: RenderedAccept,
  chain: Chain,
  seed: string,
  scenarioAssets: AssetSpec[] | undefined,
): PaymentRequirements {
  const defaults = CHAIN_DEFAULTS[chain];
  const network = accept.network ?? defaults.network;
  const asset = accept.asset ?? defaults.asset;
  // Code review F6: an `amount_usd` challenge converts through the *asset actually
  // named* (assetInfo, scenario-declared assets checked first - application-design.md
  // §3 "Asset registry"), not the chain's own default decimals - a scenario overriding
  // `asset` (rail_switch, asset_swap) without also overriding `amount_atomic` must still
  // get the right atomic amount for that asset's real decimals.
  const amount =
    accept.amount_atomic ??
    usdToAtomic(accept.amount_usd ?? 0, assetInfo(chain, asset, scenarioAssets).decimals);
  const extra: Record<string, unknown> = { ...defaults.extra, ...accept.extra };
  if (chain === "svm") {
    extra.feePayer = harnessFacilitatorAddress(seed, chain);
  }
  return {
    scheme: accept.scheme,
    network: network as Network,
    asset,
    amount,
    payTo: accept.pay_to,
    maxTimeoutSeconds: accept.max_timeout_seconds,
    extra,
  };
}

/**
 * Builds the wire `PaymentRequirements` list for a paywalled route's challenge, one
 * entry per (rendered) `accepts[]` entry, in order - per application-design.md §3 "v2"
 * (accepts_ordering) and §4 "v2" (`IssuedChallenge.accepts`). A v1 challenge (no
 * `accepts` in the YAML) resolves to a 1-element list, same as before. `scenarioAssets`
 * (a scenario's own `assets:` list, asset_swap) is threaded through to `assetInfo()` for
 * `amount_usd` conversion. Pure given (route, chain, seed, scenarioAssets): calling this
 * twice for the same inputs always yields a deep-equal result.
 */
export function buildRequirementsList(
  route: RenderedRoute,
  chain: Chain,
  seed: string,
  scenarioAssets?: AssetSpec[],
): PaymentRequirements[] {
  const challenge = route.challenge;
  if (!challenge) {
    throw new Error(`buildRequirementsList: route "${route.route_key}" has no challenge`);
  }
  return challenge.accepts.map((accept) =>
    buildOneRequirement(accept, chain, seed, scenarioAssets),
  );
}

/**
 * Builds the `PaymentRequired` envelope per functional-design.md §3 "Challenge".
 * `url` is the actual, physical request URL; `route.challenge.resource_url`, when set,
 * overrides `resource.url` on the wire (v2 resource_spoof) while the harness's own
 * ledger keeps recording against the real route.
 */
export function buildPaymentRequired(
  url: string,
  route: RenderedRoute,
  requirementsList: PaymentRequirements[],
): PaymentRequired {
  const description = route.challenge?.description ?? "";
  return {
    x402Version: 2,
    resource: {
      url: route.challenge?.resource_url ?? url,
      description,
      mimeType: route.content_type,
    },
    accepts: requirementsList,
  };
}
