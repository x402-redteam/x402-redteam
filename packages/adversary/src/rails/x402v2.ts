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

/** Order-independent deep-equality, so an `extra` object the client's JSON round-trip
 * reordered still matches (code review fix 2: field-by-field against the wire
 * `PaymentRequirements`, not a decoded/normalized value). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** The subset of `PaymentPayload` this binding check reads - every v2 scheme's payload
 * echoes `accepted` verbatim from the `PaymentRequirements` entry it chose. */
interface AcceptedEcho {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

function acceptedMatches(accepted: AcceptedEcho, requirement: PaymentRequirements): boolean {
  return (
    accepted.scheme === requirement.scheme &&
    accepted.network === requirement.network &&
    accepted.asset === requirement.asset &&
    accepted.amount === requirement.amount &&
    accepted.payTo === requirement.payTo &&
    accepted.maxTimeoutSeconds === requirement.maxTimeoutSeconds &&
    stableStringify(accepted.extra ?? {}) === stableStringify(requirement.extra ?? {})
  );
}

/**
 * ADR-014 §3 binding check, x402v2 shape (code review fix 2): the credential's *echoed*
 * `accepted` - the wire `PaymentRequirements` entry the client claims it's paying,
 * field-by-field, not a decoded/normalized value - must equal one entry of one of this
 * route's current issuance's challenges (`ctx.currentChallengeIds` - fix 7: x402v2
 * always has exactly one, MPP may have several). This is deliberately scoped to *this*
 * issuance, not "any challenge this run ever issued" (that broader attribution match is
 * capture/attribute.ts's job, unchanged) - it exists purely to surface the diagnostic
 * `binding_mismatch` flag without altering delivery, which still depends on
 * attribution's own `challenge_id` match (routes.ts).
 *
 * NOTE (deviation, reported): fix 2 also asks to compare the credential's echoed
 * `resource.url` against the issued resource URL. Verified against `@x402/core`
 * 2.28.0's actual `PaymentPayload` type: a v2 credential carries no `resource` field at
 * all (`resource` only appears on the *server's* `RouteConfig`/`PaymentRequired`, never
 * echoed back) - there is nothing on the wire to compare. Implementing this literally
 * would require either inventing a field the real SDK never sends (useless - it would
 * never match a real client) or flagging every `resource_spoof` payment as a mismatch
 * (wrong - that scenario's whole point is a legitimate payment against a route whose
 * *advertised* resource URL lies; U20's functional-design.md §4 requires behaviour to
 * stay byte-identical for that scenario). Left out pending clarification from the
 * architect on what, concretely, should be compared.
 */
function computeBinding(payload: unknown, ctx: DecodeCtx): BindingResult {
  const anyPayload = payload as { accepted?: AcceptedEcho };
  const accepted = anyPayload.accepted;
  if (!accepted) {
    // v1-shaped payload (no `accepted` to echo-check): nothing to validate here: v1
    // credentials carry no echo of what they're claiming to pay at all.
    return { challenge_ref: null, matches: true };
  }
  const current = ctx.challenges.filter((c) => ctx.currentChallengeIds.includes(c.challenge_id));
  const matched = current.find((c) => c.accepts.some((r) => acceptedMatches(accepted, r)));
  if (!matched) {
    return { challenge_ref: null, matches: false, reason: "challenge_mismatch" };
  }
  return { challenge_ref: matched.challenge_ref ?? matched.challenge_id, matches: true };
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
    // Code review fix 4: x402v2 has no separate echo-token the way MPP's `id` is - the
    // issued challenge's own id *is* its binding reference.
    challenge_ref: ctx.challenge_id,
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
  const binding = computeBinding(payload, ctx);
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
