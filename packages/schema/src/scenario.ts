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
  // v2 (Bolt 5, ADR-009 / application-design.md §3 "v2"): still a closed enum -
  // the scorer, SARIF and by_category all iterate CategorySchema.options.
  "control",
  "resource_spoof",
  "authorization_lifetime",
  "asset_swap",
  "budget_split",
  "challenge_injection",
  "accepts_ordering",
]);
export type Category = z.infer<typeof CategorySchema>;

/** Per-chain overrides merged over a challenge/accept's own fields (e.g. rail_switch mainnet ids). */
const PerChainOverrideSchema = z.partialRecord(
  z.enum(["evm", "svm"]),
  z.object({
    amount_usd: z.number().nonnegative().optional(),
    amount_atomic: z.string().optional(),
    pay_to: z.string().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }),
);

/**
 * v2 (application-design.md §3 "v2", `accepts_ordering`): one resolved entry of an
 * ordered `accepts[]` list. Mirrors `ChallengeSpec`'s own payment fields, but `pay_to`
 * is always required here (unlike `ChallengeSpec.pay_to`, which is optional once
 * `accepts` is used instead).
 */
export const AcceptSpecSchema = z.object({
  amount_usd: z.number().nonnegative().optional(),
  amount_atomic: z.string().optional(),
  pay_to: z.string(),
  network: z.string().optional(),
  asset: z.string().optional(),
  scheme: z.string().default("exact"),
  max_timeout_seconds: z.number().int().positive().default(60),
  extra: z.record(z.string(), z.unknown()).optional(),
  per_chain: PerChainOverrideSchema.optional(),
});
export type AcceptSpec = z.infer<typeof AcceptSpecSchema>;

export const ChallengeSpecSchema = z
  .object({
    amount_usd: z.number().nonnegative().optional(),
    amount_atomic: z.string().optional(),
    // v2: optional now that `accepts` is an alternative way to specify the challenge
    // (accepts_ordering); the refine below requires exactly one of the two.
    pay_to: z.string().optional(),
    // v2 (accepts_ordering): an ordered list of accepted payment options. When set,
    // it replaces the single-option `pay_to`/`amount_usd`/... fields above.
    accepts: z.array(AcceptSpecSchema).optional(),
    // v2 (resource_spoof): overrides PaymentRequired.resource.url.
    resource_url: z.string().optional(),
    // v2 (challenge_injection): replaces the 402 JSON body wholesale (templated, deep).
    body_json: z.unknown().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
    scheme: z.string().default("exact"),
    max_timeout_seconds: z.number().int().positive().default(60),
    extra: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    per_chain: PerChainOverrideSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const hasPayTo = c.pay_to !== undefined;
    const hasAccepts = c.accepts !== undefined;
    if (hasPayTo === hasAccepts) {
      ctx.addIssue({
        code: "custom",
        path: ["pay_to"],
        message: "ChallengeSpec must set exactly one of pay_to or accepts",
      });
      return;
    }
    // Code review L1: once `accepts` replaces the single-option fields, those fields
    // must not also be set (each accepts[] entry carries its own amount/network/
    // asset/extra/per_chain instead) - silently ignoring them would be surprising.
    if (hasAccepts) {
      const singleOptionFields = [
        "amount_usd",
        "amount_atomic",
        "network",
        "asset",
        "extra",
        "per_chain",
      ] as const;
      for (const field of singleOptionFields) {
        if (c[field] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `ChallengeSpec.${field} must not be set when accepts is used - set it on each accepts[] entry instead`,
          });
        }
      }
    }
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
  // v2 (ADR-015): the modelled wallet balance served by the mock RPCs and used by the
  // scorer's exposure cap. No zod `.default()` - see `walletBalanceUsd()` below - so
  // that a v1 scenario that never sets this field parses to byte-identical JSON and
  // `corpusHash` is unchanged.
  wallet_balance_usd: z.number().positive().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

/** v2 (ADR-015): `task.wallet_balance_usd` default, applied at the point of use. */
export function walletBalanceUsd(task: Task): number {
  return task.wallet_balance_usd ?? 100;
}

export const ExpectedSchema = z
  .object({
    allow: z.boolean(),
    max_usd: z.number().nonnegative().optional(),
    total_usd: z.number().nonnegative().optional(),
    recipient: z.string().optional(),
    max_payments: z.number().int().nonnegative().optional(),
    networks: z.array(z.string()).optional(),
    // v2 (ADR-009 controls): all three optional, no zod `.default()` - see the
    // `minPayments()` / `requireDelivered()` helpers below - so v1 scenarios are
    // unaffected and `corpusHash` doesn't move.
    min_payments: z.number().int().nonnegative().optional(),
    require_delivered: z.boolean().optional(),
    // v2 (authorization_lifetime, evm only): max (validBefore - validAfter) for EIP-3009.
    max_authorization_seconds: z.number().positive().optional(),
  })
  .transform((expected) => ({
    ...expected,
    max_payments: expected.max_payments ?? (expected.allow ? 1 : 0),
  }));
export type Expected = z.infer<typeof ExpectedSchema>;

/** v2 (ADR-009 controls): `expected.min_payments` default, applied at the point of use. */
export function minPayments(expected: Expected): number {
  return expected.min_payments ?? 0;
}

/** v2 (ADR-009 controls): `expected.require_delivered` default, applied at the point of use. */
export function requireDelivered(expected: Expected): boolean {
  return expected.require_delivered ?? false;
}

/**
 * v2 (asset_swap): a scenario-declared asset, merged over `chains.ts`'s `KNOWN_ASSETS`
 * by `assetInfo()`/`amountUsd()`.
 */
export const AssetSpecSchema = z.object({
  chain: ChainSchema,
  address: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nonnegative(),
  usd_price: z.number().nonnegative(),
  network: z.string().optional(),
});
export type AssetSpec = z.infer<typeof AssetSpecSchema>;

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
  // v2 (asset_swap): extra known assets for this scenario only. Optional, no default,
  // so a v1 scenario (which never sets this) is unaffected.
  assets: z.array(AssetSpecSchema).optional(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * Resolve a challenge spec for one chain: per_chain overrides win; `extra` is
 * shallow-merged. Unchanged behaviour for v1 specs (`pay_to` always set): only the
 * return type widened (`pay_to` is now optional) to accommodate v2's `accepts`
 * alternative - see `acceptsForChain()`, which is what v2 callers should use.
 */
export function challengeForChain(
  spec: ChallengeSpec,
  chain: Chain,
): Omit<ChallengeSpec, "per_chain"> {
  const { per_chain, ...base } = spec;
  const o = per_chain?.[chain];
  if (!o) return base;
  const extra = base.extra || o.extra ? { ...base.extra, ...o.extra } : undefined;
  return { ...base, ...o, pay_to: o.pay_to ?? base.pay_to, ...(extra ? { extra } : {}) };
}

/** Resolve one `AcceptSpec` for one chain: identical merge rule to `challengeForChain`. */
function resolveAcceptForChain(accept: AcceptSpec, chain: Chain): AcceptSpec {
  const { per_chain, ...base } = accept;
  const o = per_chain?.[chain];
  if (!o) return base;
  const extra = base.extra || o.extra ? { ...base.extra, ...o.extra } : undefined;
  return { ...base, ...o, pay_to: o.pay_to ?? base.pay_to, ...(extra ? { extra } : {}) };
}

/**
 * v2 (accepts_ordering): resolves a challenge's ordered `accepts[]` for one chain. A v1
 * spec (`pay_to` set, no `accepts`) resolves to the single-element list
 * `[challengeForChain(spec, chain)]`, so every existing consumer can be rewritten to
 * iterate `acceptsForChain(...)` without special-casing v1 vs v2 specs.
 */
export function acceptsForChain(spec: ChallengeSpec, chain: Chain): AcceptSpec[] {
  if (spec.accepts !== undefined) {
    return spec.accepts.map((accept) => resolveAcceptForChain(accept, chain));
  }
  const resolved = challengeForChain(spec, chain);
  if (resolved.pay_to === undefined) {
    // Unreachable when `spec` came from ChallengeSpecSchema (the refine guarantees
    // exactly one of pay_to/accepts is set), guarded here for direct callers.
    throw new Error("acceptsForChain: challenge spec has neither pay_to nor accepts set");
  }
  // Destructure away the fields ChallengeSpec has but AcceptSpec doesn't (rather than
  // listing amount_usd/amount_atomic/network/asset/scheme/max_timeout_seconds/extra
  // one by one), so a field `resolved` never had stays absent in the result instead of
  // becoming an explicit `key: undefined` - matching challengeForChain's own contract.
  const {
    pay_to,
    accepts: _accepts,
    resource_url: _resource_url,
    body_json: _body_json,
    description: _description,
    ...rest
  } = resolved;
  return [{ ...rest, pay_to }];
}
