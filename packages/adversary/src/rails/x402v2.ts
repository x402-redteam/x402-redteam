import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import {
  type AssetSpec,
  assetInfo,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  type IssuedChallenge,
  usdToAtomic,
} from "@x402-redteam/schema";
import type { RenderedAccept, RenderedRoute } from "../render.js";
import type {
  BindingResult,
  DecodeCtx,
  DecodeResult,
  IssueCtx,
  IssueResult,
  Rail,
  RawCredential,
  SettleCtx,
} from "./rail.js";

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

function eq(a: string, b: string, caseInsensitive: boolean): boolean {
  return caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * ADR-014 §3 binding check, x402v2 shape: a credential's *decoded* terms (which, for
 * both v1- and v2-shaped payloads, are already normalized by `capture.decodePayload`)
 * must match one of the entries the currently-issued challenge for this route actually
 * offered. This is deliberately scoped to *this* issuance (`ctx.currentChallengeId`),
 * not "any challenge this run ever issued" (that broader attribution match is
 * capture/attribute.ts's job, unchanged) - it exists purely to surface the diagnostic
 * `challenge_mismatch` reason without altering delivery, which still depends on
 * attribution's own `challenge_id` match (routes.ts).
 */
function computeBinding(
  decoded: { chain: Chain; network: string; asset: string; to: string; amount_atomic: string },
  ctx: DecodeCtx,
): BindingResult {
  const current = ctx.challenges.find((c) => c.challenge_id === ctx.currentChallengeId);
  if (!current) {
    return { challenge_ref: null, matches: false, reason: "challenge_mismatch" };
  }
  const evmCase = decoded.chain === "evm";
  const matches = current.accepts.some(
    (r) =>
      eq(r.network, decoded.network, false) &&
      eq(r.asset, decoded.asset, evmCase) &&
      eq(r.payTo, decoded.to, evmCase) &&
      r.amount === decoded.amount_atomic,
  );
  return matches
    ? { challenge_ref: current.challenge_id, matches: true }
    : { challenge_ref: current.challenge_id, matches: false, reason: "challenge_mismatch" };
}

function issue(ctx: IssueCtx): IssueResult {
  const requirementsList = buildRequirementsList(
    ctx.route,
    ctx.chain,
    ctx.seed,
    ctx.scenarioAssets,
  );
  const paymentRequired = buildPaymentRequired(ctx.url, ctx.route, requirementsList);
  const issued: IssuedChallenge = {
    challenge_id: ctx.challenge_id,
    route_key: ctx.route.route_key,
    // Kept for v1 readers; the first entry, per application-design.md §4 "v2".
    requirements: requirementsList[0] as (typeof requirementsList)[number],
    // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on
    // the wire, in order.
    accepts: requirementsList,
    seq: ctx.seq,
    rail: "x402v2",
  };
  // v2 (challenge_injection): a scenario-supplied body_json replaces the default 402
  // body wholesale and, like any other page-visible text, is searched by prose
  // attribution - routes.ts pushes it into pageBodies when it's actually used.
  const body =
    ctx.route.challenge?.body_json ??
    ({ x402Version: 2, error: "payment_required", accepts: requirementsList } as const);
  return {
    status: 402,
    headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
    body,
    issued: [issued],
  };
}

function extract(req: Request): RawCredential | null {
  const headerValue = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT");
  return headerValue ? { raw: headerValue } : null;
}

async function decode(raw: RawCredential, ctx: DecodeCtx): Promise<DecodeResult> {
  // Both steps below throw on a malformed/undecodable credential; the caller (routes.ts)
  // treats either failure as one undifferentiated `invalid_payment`, same as before this
  // port (the two were separate try/catches producing an identical response).
  const payload = decodePaymentSignatureHeader(raw.raw as string);
  const decoded = await ctx.capture.decodePayload(payload, ctx.hints);
  const binding = computeBinding(decoded, ctx);
  return { legs: [decoded], binding };
}

function settle(result: SettleCtx): Record<string, string> {
  const response: SettleResponse = result.success
    ? {
        success: true,
        transaction: result.transaction,
        network: result.network as Network,
        payer: result.payer,
      }
    : {
        success: false,
        errorReason: result.errorReason ?? "invalid_payment",
        transaction: result.transaction,
        network: result.network as Network,
        payer: result.payer,
      };
  return { "PAYMENT-RESPONSE": encodePaymentResponseHeader(response) };
}

/** The x402 v2 `Rail` implementation (ADR-014). The only rail actually built in Bolt 6. */
export const x402v2Rail: Rail = {
  id: "x402v2",
  issue,
  extract,
  decode,
  settle,
};
