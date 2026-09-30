import type { PaymentRequirements } from "@x402/core/types";
import { z } from "zod";
import { ChainSchema } from "./scenario.js";

export const IssuedChallengeSchema = z.object({
  challenge_id: z.string(),
  route_key: z.string(),
  // v2 (accepts_ordering, application-design.md §4 "v2"): every entry that went on the
  // wire, in order. `requirements` is kept (= `accepts[0]`) for v1 readers.
  requirements: z.custom<PaymentRequirements>(() => true),
  accepts: z.array(z.custom<PaymentRequirements>(() => true)),
  seq: z.number().int().nonnegative(),
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
  timing: z.object({
    duration_ms: z.number().nonnegative(),
  }),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;
