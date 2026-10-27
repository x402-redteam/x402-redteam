import type { PaymentRequirements } from "@x402/core/types";
import { z } from "zod";
import { ChainSchema, RailSchema } from "./scenario.js";

/** One MCP channel's offer: the `accepts` value of the object it carried. */
export const ChannelOfferSchema = z.object({ accepts: z.unknown() });
export type ChannelOffer = z.infer<typeof ChannelOfferSchema>;
export const MCP_CHANNELS = ["structured", "text", "error"] as const;
export type McpChannel = (typeof MCP_CHANNELS)[number];

export const IssuedChallengeSchema = z.object({
  challenge_id: z.string(),
  route_key: z.string(),
  // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on the
  // wire, in order. `requirements` is kept (= `accepts[0]`) for v1 readers.
  // Absent on a wire issuance (U29-1) whose first offered entry is not readable: the typed
  // build is never substituted for what was served.
  requirements: z.custom<PaymentRequirements>(() => true).optional(),
  accepts: z.array(z.custom<PaymentRequirements>(() => true)),
  seq: z.number().int().nonnegative(),
  // v3 (ADR-014 rail port): the rail that issued this challenge. Optional, no default -
  // `IssuedChallenge`s are built in adversary code, not corpus YAML, so a default here
  // wouldn't move `corpusHash` but would force every existing call site to set it for no
  // benefit; U20 (the rail port's owner) is the one that actually sets it.
  rail: RailSchema.optional(),
  // v3 (ADR-014 rail binding check, U20 fills it in): a generic "does this credential's
  // echoed terms match what was issued" reference - MPP's `id`/HMAC, x402's `accepted`
  // echo, and a future tampered-credential scenario all key off this one field.
  challenge_ref: z.string().optional(),
  // v5 (U29-1, ADR-032): present only when the challenge was served through `wire`. Then
  // `accepts` is the PATCHED object's readable entries (the offered terms), not the typed
  // build. `parseable` is false when no terms can be read from the header (an
  // `invalid_json` or `raw:` header, or a patch that left `accepts` unreadable): `accepts`
  // is then empty and any signature is unmatched. `unreadable_entries` counts patched
  // entries left out of `accepts` because a term the harness reads is not a string.
  // v7 (U30-4): an MCP issuance under `wire` records `encoding: "standard"` (an MCP object has
  // no header encoding; the enum is not widened) and `header_sha256` of the object's JSON text.
  wire: z
    .object({
      encoding: z.enum(["standard", "url_safe", "unpadded", "invalid_json", "raw", "raw_json"]),
      parseable: z.boolean(),
      unreadable_entries: z.number().int().nonnegative(),
      /** The header object exactly as served (after patch and rendering), type-confused
       * values intact; absent when the header does not decode to an object. */
      offered: z.unknown().optional(),
      /** sha256 (hex) of the exact header value served. */
      header_sha256: z.string(),
    })
    .optional(),
  // v7 (U30-4, ADR-032 #5): present only on an MCP issuance whose `wire.channels` is set and is
  // not `both`. Each key is a channel that carried a JSON object: `structured`
  // (`structuredContent`), `text` (`content` text) or `error` (the JSON-RPC error's data).
  // `accepts` is that object's `accepts` value as served (unfiltered, any JSON type; null when
  // the object has none), so the manifest's per-channel hash derives from it. `accepts` above
  // is then the union of the channels' readable entries (structured, text, error; identical
  // entries once), so a client that follows either channel is matched to an offer that was
  // actually served.
  channels: z
    .object({
      structured: ChannelOfferSchema.optional(),
      text: ChannelOfferSchema.optional(),
      error: ChannelOfferSchema.optional(),
    })
    .optional(),
});
export type IssuedChallenge = z.infer<typeof IssuedChallengeSchema>;

/** v4 (U26-2): the single capture layers, in canonical (alphabetical) order. */
export const CAPTURE_LAYERS = ["header", "rpc", "shim", "submitted"] as const;
export type CaptureLayer = (typeof CAPTURE_LAYERS)[number];

/** Every non-empty combination of `CAPTURE_LAYERS`, each joined with "+" in canonical
 * order - the values `Payment.capture` can take. */
export const CAPTURE_LABELS = [
  "header",
  "rpc",
  "shim",
  "submitted",
  "header+rpc",
  "header+shim",
  "header+submitted",
  "rpc+shim",
  "rpc+submitted",
  "shim+submitted",
  "header+rpc+shim",
  "header+rpc+submitted",
  "header+shim+submitted",
  "rpc+shim+submitted",
  "header+rpc+shim+submitted",
] as const;

export const PaymentSchema = z.object({
  payment_id: z.string(),
  seq: z.number().int().nonnegative(),
  // Every capture layer that saw this payment, joined with "+" in canonical order
  // header, rpc, shim, submitted (ADR-013; `submitted` is v4, U26-2: a signature the agent
  // POSTed to a collect_signature route). "header+rpc" happens when a signed authorization
  // or tx arrives in a PAYMENT-SIGNATURE header and is also submitted to a mock RPC.
  capture: z.enum(CAPTURE_LABELS),
  chain: ChainSchema,
  network: z.string(),
  scheme: z.string(),
  asset: z.string(),
  from: z.string(),
  to: z.string(),
  amount_atomic: z.string(),
  amount_usd: z.number(),
  /** Why `valid` is false (e.g. "negative_amount", "bad_signature"); absent when valid. */
  invalid_reason: z.string().optional(),
  route_key: z.string().optional(),
  host: z.string().optional(),
  dedupe_key: z.string(),
  instruction_source: z.enum(["header", "prose", "none"]),
  challenge_id: z.string().optional(),
  replay: z.boolean(),
  valid: z.boolean(),
  raw: z.unknown().optional(),
  // v2 (application-design.md §4 "v2"): from `assetInfo()`; absent is treated as `true`
  // at the point of use (no zod `.default()`, so existing Payment literals across the
  // workspace - none of which set this field yet - still typecheck; U10's decoders are
  // the ones that will start setting it).
  asset_known: z.boolean().optional(),
  // v2 (authorization_lifetime, evm EIP-3009 only): validBefore - validAfter. Code
  // review L3: no `.nonnegative()` - a negative window (validBefore before validAfter,
  // or before "now") is itself a signal the scorer/U11 corpus may want to catch, not a
  // shape the schema should reject.
  authorization_seconds: z.number().optional(),
  // v3 (ADR-016 #2, fixes N1): computed by the scorer from `authorization_seconds`
  // against `max_authorization_seconds` (+5s tolerance) and persisted here, so the
  // leaderboard's re-score check can reproduce `excessive_authorization_window` without
  // needing the wall-clock-tainted `authorization_seconds` itself (which stays
  // stripped from report.json). Absent when authorization_lifetime doesn't apply to
  // this payment (e.g. svm, or no `max_authorization_seconds` on the scenario).
  authorization_window_exceeded: z.boolean().optional(),
  // v3 (ADR-014 §3 rail port, U20 code review fix 3 - orchestrator ruling): true when
  // the rail's binding check found this payment's echoed terms don't match what was
  // actually issued. Deliberately a separate boolean, never folded into
  // `invalid_reason`/`valid` - a mismatched credential can still be a validly signed
  // payment (`valid: true`), just not one answering the challenge it was submitted
  // against; delivery already depends solely on attribution's own `challenge_id` match.
  binding_mismatch: z.boolean().optional(),
  // v4 (grant scoring): legs signed together for one payment share this id. It is set on
  // every leg of a header submission that carried more than one leg, and on a grant
  // captured off the header path together with the Permit2 witness transfer it shares an
  // owner, token and deadline with. The value is the payment_id of the first leg
  // recorded, so it is deterministic. The scorer reads it to find the payment a Permit2
  // allowance belongs to (`standing_approval`); it is persisted in report.runs[] so a
  // re-score reproduces that decision without the unpersisted signing payloads.
  submission: z.string().optional(),
  // v4 (grant scoring): true only when the decoder recognised this grant leg as a
  // revocation (`DecodedPayment.revocation`). The scorer treats a grant leg as benign
  // only on this flag, so it is persisted for the leaderboard re-score.
  revocation: z.boolean().optional(),
  // v5 (U29-0, ledger only; scoreSuite strips both from report.json): see DecodedPayment.
  decode_error: z.string().optional(),
  terms_verified: z.enum(["offered", "offered_domain_only", "client_copy", "none"]).optional(),
  // v6 (U30-0, ADR-034): present only on a payment that arrived over MCP
  // (`params._meta["x402/payment"]`); absent for HTTP, so existing ledgers are unchanged.
  transport: z.literal("mcp").optional(),
});
export type Payment = z.infer<typeof PaymentSchema>;

/** Code review L4: `payment.asset_known` default, applied at the point of use - mirrors
 * `walletBalanceUsd()`/`minPayments()`/`requireDelivered()` in scenario.ts. */
export function assetKnown(payment: Payment): boolean {
  return payment.asset_known ?? true;
}

export const RequestLogSchema = z.object({
  seq: z.number().int().nonnegative(),
  method: z.string(),
  host: z.string(),
  path: z.string(),
  status: z.number().int(),
  paid: z.boolean(),
  // v6 (U30-0, ADR-034): the MCP tool name; present only on an MCP exchange's log,
  // absent for HTTP.
  tool: z.string().optional(),
  // v6 (U30 review): set to false only on a paid MCP `tools/call` that returned no result
  // (a `no_delivery` tool). Absent means nothing: every other exchange omits it, so existing
  // logs are unchanged.
  delivered: z.literal(false).optional(),
});
export type RequestLog = z.infer<typeof RequestLogSchema>;

/**
 * U27: the ids a published result may carry as `agent_id` and `guardrail_id`. The
 * leaderboard rejects any `results/` entry whose ids don't match, so an id can never
 * carry markdown (`|`, `\`, spaces, newlines) into LEADERBOARD.md. The CLI still
 * records whatever `--agent-id`/`--guardrail-id` a local run is given.
 */
export const RESULT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ResultIdSchema = z.string().regex(RESULT_ID_PATTERN);

export const RunRecordSchema = z.object({
  run_id: z.string(),
  scenario_id: z.string(),
  chain: ChainSchema,
  attempt: z.number().int().nonnegative(),
  agent_id: z.string(),
  guardrail_id: z.string(),
  requests: z.array(RequestLogSchema),
  challenges: z.array(IssuedChallengeSchema),
  payments: z.array(PaymentSchema),
  delivered: z.boolean(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  /**
   * Guardrail track only (ADR-010 §2): decisions the guardrail failed to give properly
   * (timeout, crash, malformed reply). Each was treated as deny; counting them keeps a
   * broken guardrail visible instead of looking like a deliberate deny.
   */
  guardrail_errors: z.number().int().nonnegative().optional(),
  timing: z.object({
    duration_ms: z.number().nonnegative(),
  }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
