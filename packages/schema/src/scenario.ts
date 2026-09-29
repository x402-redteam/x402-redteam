import { z } from "zod";

export const ChainSchema = z.enum(["evm", "svm"]);
export type Chain = z.infer<typeof ChainSchema>;

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const CategorySchema = z.enum([
  "ghost_paywall",
  "prose_payment",
  "recipient_redirect",
  "price_bait",
  "retry_storm",
  "fake_delivery",
  "replay",
  "unit_confusion",
  "lookalike_domain",
  "rail_switch",
]);
export type Category = z.infer<typeof CategorySchema>;

export const ChallengeSpecSchema = z.object({
  amount_usd: z.number().nonnegative().optional(),
  amount_atomic: z.string().optional(),
  pay_to: z.string(),
  network: z.string().optional(),
  asset: z.string().optional(),
  scheme: z.string().default("exact"),
  max_timeout_seconds: z.number().int().positive().default(60),
  extra: z.record(z.string(), z.unknown()).optional(),
  description: z.string().optional(),
});
export type ChallengeSpec = z.infer<typeof ChallengeSpecSchema>;

export const RouteSchema = z.object({
  host: z.string().default("provider.test"),
  path: z.string(),
  method: z.enum(["GET", "POST"]).default("GET"),
  page: z.string().optional(),
  content_type: z.string().default("text/markdown"),
  redirect: z.string().optional(),
  challenge: ChallengeSpecSchema.optional(),
  behaviour: z.enum(["normal", "402_forever", "no_delivery", "replay"]).default("normal"),
  delivered_body: z.string().optional(),
});
export type Route = z.infer<typeof RouteSchema>;

export const TaskSchema = z.object({
  prompt: z.string(),
  budget_usd: z.number().nonnegative().optional(),
  allowed_hosts: z.array(z.string()).optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ExpectedSchema = z
  .object({
    allow: z.boolean(),
    max_usd: z.number().nonnegative().optional(),
    total_usd: z.number().nonnegative().optional(),
    recipient: z.string().optional(),
    max_payments: z.number().int().nonnegative().optional(),
    networks: z.array(z.string()).optional(),
  })
  .transform((expected) => ({
    ...expected,
    max_payments: expected.max_payments ?? (expected.allow ? 1 : 0),
  }));
export type Expected = z.infer<typeof ExpectedSchema>;

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: CategorySchema,
  severity: SeveritySchema,
  chains: z.array(ChainSchema).default(["evm", "svm"]),
  description: z.string(),
  task: TaskSchema,
  routes: z.array(RouteSchema),
  expected: ExpectedSchema,
});
export type Scenario = z.infer<typeof ScenarioSchema>;
