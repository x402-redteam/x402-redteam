import type { PaymentRequirements } from "@x402/core/types";
import { z } from "zod";
import { ChainSchema, RailSchema } from "./scenario.js";

export const IssuedChallengeSchema = z.object({
  challenge_id: z.string(),
  route_key: z.string(),
  // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on the
  // wire, in order. `requirements` is kept (= `accepts[0]`) for v1 readers.
  requirements: z.custom<PaymentRequirements>(() => true),
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
});
export type IssuedChallenge = z.infer<typeof IssuedChallengeSchema>;

export const PaymentSchema = z.object({
  payment_id: z.string(),
  seq: z.number().int().nonnegative(),
  // Every capture layer that saw this payment, joined with "+" in canonical order
  // header, rpc, shim (ADR-013). "header+rpc" happens when a signed authorization or tx
  // arrives in a PAYMENT-SIGNATURE header and is also submitted to a mock RPC.
  capture: z.enum([
    "header",
    "rpc",
    "shim",
    "header+rpc",
    "header+shim",
    "rpc+shim",
    "header+rpc+shim",
  ]),
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
});
export type RequestLog = z.infer<typeof RequestLogSchema>;

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
