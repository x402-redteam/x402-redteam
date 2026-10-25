import { createHash } from "node:crypto";
import {
  decodePaymentRequiredHeader,
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
  applyMergePatch,
  assetInfo,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  type IssuedChallenge,
  usdToAtomic,
  WIRE_RAW_JSON_PREFIX,
  WIRE_RAW_PREFIX,
  type WireEncodingKind,
  wireEncodingKind,
} from "@x402-redteam/schema";
import type { RenderedAccept, RenderedRoute } from "../render.js";
import type {
  BindingResult,
  ChallengeBuild,
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
    // v4 (U26-2): server-declared extensions; the SDK client passes them to the scheme.
    ...(route.challenge?.extensions !== undefined
      ? { extensions: route.challenge.extensions }
      : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An entry the harness can read as offered terms: every term that attribution, the binding
 * check and capture compare is a string (`extra`, when present, an object). */
export function readableRequirement(value: unknown): value is PaymentRequirements {
  if (!isRecord(value)) return false;
  return (
    ["scheme", "network", "asset", "amount", "payTo"].every((k) => typeof value[k] === "string") &&
    (value.extra === undefined || isRecord(value.extra))
  );
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The `PAYMENT-REQUIRED` header value for `patched` under `kind` (U29-1, ADR-032). */
function encodeWireHeader(
  patched: Record<string, unknown>,
  kind: WireEncodingKind,
  encoding: string,
): string {
  const json = JSON.stringify(patched);
  switch (kind) {
    case "url_safe":
      return toBase64(json).replace(/\+/g, "-").replace(/\//g, "_");
    case "unpadded":
      return toBase64(json).replace(/=+$/, "");
    case "invalid_json":
      // Valid base64 whose text is not JSON: the object, cut one character short.
      return toBase64(json.slice(0, -1));
    case "raw":
      return encoding.slice(WIRE_RAW_PREFIX.length);
    case "raw_json":
      return toBase64(encoding.slice(WIRE_RAW_JSON_PREFIX.length));
    default:
      return encodePaymentRequiredHeader(patched as unknown as PaymentRequired);
  }
}

/**
 * The wire header for a typed challenge under a `wire` override, plus the object a client
 * can read from it (`offered`; undefined when nothing parses). Pure: shared by `issueWire`
 * and `offeredAcceptsFor`, so the manifest hash cannot drift from what is served.
 */
function wireHeader(
  paymentRequired: PaymentRequired,
  wire: NonNullable<NonNullable<RenderedRoute["challenge"]>["wire"]>,
): {
  header: string;
  patched: Record<string, unknown>;
  offered: Record<string, unknown> | undefined;
} {
  const encoding = wire.encoding ?? "standard";
  const kind = wireEncodingKind(encoding);
  const patched = applyMergePatch(
    JSON.parse(JSON.stringify(paymentRequired)),
    wire.patch ?? {},
  ) as Record<string, unknown>;
  const header = encodeWireHeader(patched, kind, encoding);

  // What the client can read from the header: the patched object for the encoded forms, the
  // decoded object for a decodable `raw:` / `raw_json:` header, nothing for invalid_json.
  let offered: Record<string, unknown> | undefined;
  if (kind === "raw" || kind === "raw_json") {
    try {
      const decoded: unknown = decodePaymentRequiredHeader(header);
      if (isRecord(decoded)) offered = decoded;
    } catch {
      offered = undefined;
    }
  } else if (kind !== "invalid_json") {
    offered = patched;
  }
  return { header, patched, offered };
}

/**
 * The `accepts` list a client can read from a route's challenge: the typed list for a plain
 * challenge, the offered object's `accepts` under a `wire` override, or null when the header
 * carries none (`invalid_json`, an undecodable `raw:`, or no `accepts` array). `rawAccepts`
 * is the offered `accepts` value as served, whatever its JSON type (an object or a string
 * stays itself), or null when the header carries no `accepts` key at all. A pure function of
 * (route, chain, seed, scenarioAssets); the fuzz manifest hashes `rawAccepts`, which is what
 * `diff` re-hashes from the run record (U29-2).
 */
export function offeredAcceptsFor(
  route: RenderedRoute,
  chain: Chain,
  seed: string,
  scenarioAssets?: AssetSpec[],
): { accepts: unknown[] | null; rawAccepts: unknown; encoding: WireEncodingKind } {
  const list = buildRequirementsList(route, chain, seed, scenarioAssets);
  const wire = route.challenge?.wire;
  if (wire === undefined) return { accepts: list, rawAccepts: list, encoding: "standard" };
  const paymentRequired = buildPaymentRequired("http://offered.invalid/", route, list);
  const { offered } = wireHeader(paymentRequired, wire);
  return {
    accepts: Array.isArray(offered?.accepts) ? (offered.accepts as unknown[]) : null,
    rawAccepts: offered?.accepts === undefined ? null : offered.accepts,
    encoding: wireEncodingKind(wire.encoding ?? "standard"),
  };
}

/**
 * Wire-level override (U29-1, ADR-032): applies the merge patch to the decoded typed
 * header object, encodes it, and records the PATCHED object's readable entries as the
 * offered terms (N2), so attribution, the binding check and capture's `offeredTerms` all
 * see what the client saw. A header that carries no readable terms (`invalid_json`, `raw:`
 * or an unreadable `accepts`) is recorded as offered but unparseable: `accepts` is empty.
 */
function issueWire(
  ctx: IssueCtx,
  wire: NonNullable<NonNullable<RenderedRoute["challenge"]>["wire"]>,
  requirementsList: PaymentRequirements[],
  paymentRequired: PaymentRequired,
): IssueResult {
  const encoding = wire.encoding ?? "standard";
  const kind = wireEncodingKind(encoding);
  const { header, patched, offered } = wireHeader(paymentRequired, wire);

  const entries: unknown[] = Array.isArray(offered?.accepts) ? (offered?.accepts as unknown[]) : [];
  const accepts = entries.filter(readableRequirement);
  const issued: IssuedChallenge = {
    challenge_id: ctx.challenge_id,
    route_key: ctx.route.route_key,
    // Never the typed build: the first readable offered entry, or none.
    ...(accepts[0] !== undefined ? { requirements: accepts[0] } : {}),
    accepts,
    seq: ctx.seq,
    rail: "x402v2",
    challenge_ref: ctx.challenge_id,
    wire: {
      encoding: kind,
      parseable: Array.isArray(offered?.accepts),
      unreadable_entries: entries.length - accepts.length,
      ...(offered !== undefined ? { offered } : {}),
      header_sha256: createHash("sha256").update(header).digest("hex"),
    },
  };

  const mode = wire.body ?? "same";
  const source = offered ?? patched;
  let body: unknown;
  if (mode === "none") {
    body = undefined;
  } else if (ctx.route.challenge?.body_json !== undefined) {
    body = ctx.route.challenge.body_json;
  } else if (mode === "differs") {
    body = { x402Version: 2, error: "payment_required", accepts: requirementsList };
  } else {
    body = {
      ...(source.x402Version !== undefined ? { x402Version: source.x402Version } : {}),
      error: "payment_required",
      ...(source.accepts !== undefined ? { accepts: source.accepts } : {}),
    };
  }
  return { status: 402, headers: { "PAYMENT-REQUIRED": header }, body, issued: [issued] };
}

/** The plain (no `wire` override) issued challenge for `ctx`; shared by HTTP and MCP. */
function plainIssued(ctx: IssueCtx, requirementsList: PaymentRequirements[]): IssuedChallenge {
  return {
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
}

/**
 * U30-1 (m7): the transport-free half of `issue`: the `PaymentRequired` object and its
 * `IssuedChallenge`. `ctx.url` becomes `resource.url` unless the route's `resource_url`
 * overrides it. This is the typed, unpatched build: the MCP transport applies a `wire`
 * override itself (`planChannels`), because where the object is placed is transport-specific.
 */
function buildChallenge(ctx: IssueCtx): ChallengeBuild {
  const requirementsList = buildRequirementsList(
    ctx.route,
    ctx.chain,
    ctx.seed,
    ctx.scenarioAssets,
  );
  return {
    paymentRequired: buildPaymentRequired(ctx.url, ctx.route, requirementsList),
    issued: [plainIssued(ctx, requirementsList)],
  };
}

function issue(ctx: IssueCtx): IssueResult {
  const requirementsList = buildRequirementsList(
    ctx.route,
    ctx.chain,
    ctx.seed,
    ctx.scenarioAssets,
  );
  const paymentRequired = buildPaymentRequired(ctx.url, ctx.route, requirementsList);
  const wire = ctx.route.challenge?.wire;
  if (wire !== undefined) return issueWire(ctx, wire, requirementsList, paymentRequired);
  const issued = plainIssued(ctx, requirementsList);
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
  // U29-0: this no longer throws on a malformed credential. An undecodable header or
  // payload comes back as a `decode_error` leg (recorded on the ledger), and routes.ts
  // answers it with the same 400 `invalid_payment` it always gave.
  let payload: unknown;
  try {
    payload = decodePaymentSignatureHeader(raw.raw as string);
  } catch {
    // U29-0: a header that isn't a payload at all is still recorded, as a decode_error leg.
    payload = raw.raw;
  }
  return decodeObject(payload, ctx);
}

/** U30-1 (m7): the transport-free half of `decode`, for an already-extracted credential. */
async function decodeObject(payload: unknown, ctx: DecodeCtx): Promise<DecodeResult> {
  const offeredTerms = ctx.challenges
    .filter((c) => ctx.currentChallengeIds.includes(c.challenge_id))
    .flatMap((c) =>
      c.accepts.map((r) => ({
        network: r.network,
        asset: r.asset,
        payTo: r.payTo,
        amount: r.amount,
        ...(r.extra !== undefined ? { extra: r.extra as Record<string, unknown> } : {}),
      })),
    );
  const decoded = await ctx.capture.decodePayload(payload, { ...ctx.hints, offeredTerms });
  const binding = (() => {
    try {
      return computeBinding(payload, ctx);
    } catch {
      return { challenge_ref: null, matches: false, reason: "challenge_mismatch" } as BindingResult;
    }
  })();
  return { legs: [decoded], binding };
}

/** U30-1 (m7): the transport-free settlement response object. */
function settleObject(result: SettleCtx): SettleResponse {
  return result.success
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
}

function settle(result: SettleCtx): Record<string, string> {
  return { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settleObject(result)) };
}

/** The x402 v2 `Rail` implementation (ADR-014). The only rail actually built in Bolt 6. */
export const x402v2Rail: Rail = {
  id: "x402v2",
  issue,
  extract,
  decode,
  settle,
  buildChallenge,
  decodeObject,
  settleObject,
};
