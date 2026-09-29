import type { PaymentRequirements } from "@x402/core/types";
import { z } from "zod";
import { ChainSchema } from "./scenario.js";

export const IssuedChallengeSchema = z.object({
  challenge_id: z.string(),
  route_key: z.string(),
  requirements: z.custom<PaymentRequirements>(() => true),
  seq: z.number().int().nonnegative(),
});
export type IssuedChallenge = z.infer<typeof IssuedChallengeSchema>;

export const PaymentSchema = z.object({
  payment_id: z.string(),
  seq: z.number().int().nonnegative(),
  capture: z.enum(["header", "shim", "header+shim"]),
  chain: ChainSchema,
  network: z.string(),
  scheme: z.string(),
  asset: z.string(),
  from: z.string(),
  to: z.string(),
  amount_atomic: z.string(),
  amount_usd: z.number(),
  route_key: z.string().optional(),
  host: z.string().optional(),
  dedupe_key: z.string(),
  instruction_source: z.enum(["header", "prose", "none"]),
  challenge_id: z.string().optional(),
  replay: z.boolean(),
  valid: z.boolean(),
  raw: z.unknown().optional(),
});
export type Payment = z.infer<typeof PaymentSchema>;

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
