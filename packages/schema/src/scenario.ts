import { z } from "zod";
import { isWireEncoding, parseWireChannels, wireEncodingProblem } from "./wire.js";

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
  // v4 (U26-3, Bolt 9, review M5/Q4): three categories whose measured signature is new -
  // a standing approval signed alongside a payment, a signature that is not a payment,
  // and purchases decided together against one budget.
  "transfer_method_switch",
  "signature_request",
  "concurrent_spend",
]);
export type Category = z.infer<typeof CategorySchema>;

/**
 * v3 (ADR-016 reach/`reached`, Bolt 6): required on every attack scenario, forbidden on
 * `control` (lint rule 7, `load.ts`). Marks *why* a given scenario's attack surface is
 * reachable, so a bare, no-guardrail probe's pass on an unreached attack isn't mistaken
 * for a safe policy (see `corpus/README.md`'s "Circularity evidence" table, whose
 * `ProbeClass` this type mirrors exactly).
 */
export const ReachClassSchema = z.enum(["crawl", "repeat", "prose", "challenge"]);
export type ReachClass = z.infer<typeof ReachClassSchema>;

/** v3 (ADR-014 rail port): which payment-challenge protocol a scenario speaks. Only
 * `x402v2` is implemented in Bolt 6; `x402v1` and `mpp` are reserved for the rail port
 * (U20) and the MPP rail (Bolt 7). */
export const RailSchema = z.enum(["x402v2", "x402v1", "mpp"]);
export type Rail = z.infer<typeof RailSchema>;

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

/**
 * U29-1 (ADR-032): wire-level overrides of what a challenge looks like on the wire, applied
 * after the typed build. Optional with no zod defaults, so a scenario without `wire` parses
 * to the same JSON and `corpusHash` is unchanged. Only generated and private corpora use it.
 */
export const WireSpecSchema = z.object({
  /** RFC 7396 merge patch over the decoded `PAYMENT-REQUIRED` object. A JSON object;
   * `null` deletes a key and arrays replace whole, so write the entire `accepts` array. */
  patch: z.record(z.string(), z.unknown()).optional(),
  /** `standard` (default), `url_safe`, `unpadded`, `invalid_json` or `raw:<string>`. */
  encoding: z
    .string()
    .refine(isWireEncoding, {
      message:
        "encoding must be standard, url_safe, unpadded, invalid_json, raw:<string> or raw_json:<json>",
    })
    .superRefine((value, ctx) => {
      const problem = wireEncodingProblem(value);
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional(),
  /** `same` (default): the 402 body mirrors the patched challenge. `differs`: the body
   * carries the unpatched typed challenge. `none`: no body. */
  body: z.enum(["same", "differs", "none"]).optional(),
  /** v6 (U30-4, ADR-032 #5): MCP tool routes only, generated corpora only. Where the
   * (patched) `PaymentRequired` goes: `both` (absent means the same), `structured_only`,
   * `text_only`, `text_differs`, `structured_differs`, `text_second`,
   * `structured_raw:<json>`, `text_raw:<string>`, `jsonrpc:<code>`, `jsonrpc_ns:<code>`,
   * `jsonrpc_elicit:<code>` or `not_error`. No zod default: it is applied where used, so a
   * scenario without it parses to the same JSON and no corpus hash moves. */
  channels: z
    .string()
    .refine((v) => parseWireChannels(v) !== null, {
      message:
        "channels must be both, structured_only, text_only, text_differs, structured_differs, text_second, not_error, structured_raw:<json>, text_raw:<string>, or jsonrpc|jsonrpc_ns|jsonrpc_elicit:<integer code>",
    })
    .optional(),
});
export type WireSpec = z.infer<typeof WireSpecSchema>;

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
    // v4 (U26-2): `PaymentRequired.extensions`, the server-declared extensions object
    // (e.g. `erc20ApprovalGasSponsoring`, `eip2612GasSponsoring`). Deep-templated like
    // `body_json`; the SDK passes it to the scheme as context.
    extensions: z.record(z.string(), z.unknown()).optional(),
    // v5 (U29-1, ADR-032): wire-level overrides. Not used in the public corpus.
    wire: WireSpecSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.wire?.body === "none" && c.body_json !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["wire", "body"],
        message: "wire.body none cannot be combined with body_json",
      });
    }
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

/**
 * v4 (U26-2, M2): what a `collect_signature` route asks the agent to sign. Exactly one of
 * `typed_data`, `digest`, `message` or `authorization` is set, matching `kind`. Every
 * string inside is templated. EVM only.
 */
export const SignRequestSpecSchema = z
  .object({
    kind: z.enum(["typed_data", "digest", "message", "authorization"]),
    /** EIP-712 typed data, as passed to viem's `signTypedData`. */
    typed_data: z
      .object({
        domain: z.record(z.string(), z.unknown()),
        types: z.record(z.string(), z.unknown()),
        primaryType: z.string(),
        message: z.record(z.string(), z.unknown()),
      })
      .optional(),
    /** A 32-byte hex digest, signed as-is (viem `sign({hash})`). */
    digest: z.string().optional(),
    /** An EIP-191 personal message. */
    message: z.string().optional(),
    /** An EIP-7702 authorization tuple: delegate `address`, `chain_id` (0 = any chain). */
    authorization: z
      .object({
        chain_id: z.number().int().nonnegative(),
        address: z.string(),
        nonce: z.number().int().nonnegative().default(0),
      })
      .optional(),
    /** Where the signature is POSTed: a path on the route's own host. */
    submit_path: z.string(),
    /** 200 serves the request as a page; 402 serves it as a 402 body with no x402
     * challenge header. */
    status: z.union([z.literal(200), z.literal(402)]).default(200),
    /** Prose served alongside the request (the cover story). */
    text: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    const set = (["typed_data", "digest", "message", "authorization"] as const).filter(
      (k) => r[k] !== undefined,
    );
    if (set.length !== 1 || set[0] !== r.kind) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: `sign_request must set exactly the field named by kind ("${r.kind}")`,
      });
    }
  });
export type SignRequestSpec = z.infer<typeof SignRequestSpecSchema>;

/** v6 (U30-0, ADR-035): the transport a scenario speaks. */
export const TransportSchema = z.enum(["http", "mcp"]);
export type Transport = z.infer<typeof TransportSchema>;

/** v6 (U30-0): `scenario.transport` default, applied at the point of use. */
export function scenarioTransport(scenario: { transport?: Transport | undefined }): Transport {
  return scenario.transport ?? "http";
}

/** v6 (U30-0, ADR-034): the one path every MCP tool route is served on. */
export const MCP_PATH = "/mcp";

/**
 * v6 (U30-0): an MCP tool. A route with `tool` is a paywalled MCP tool served by the
 * adversary at `POST /mcp`. Loose, so an unknown key such as `outputSchema` survives
 * parsing and lint can name it (the adversary never emits `outputSchema`).
 */
export const ToolSpecSchema = z.looseObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "tool.name must match ^[a-z][a-z0-9_]{0,63}$"),
  description: z.string(),
  /** JSON Schema for the tool's arguments; `type` must be "object" (the MCP SDK rejects
   * anything else). Property descriptions are text the model reads (lint rule 3). */
  input_schema: z
    .looseObject({
      type: z.literal("object", { error: 'tool.input_schema.type must be "object"' }),
    })
    .default({ type: "object" }),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/** v6 (U30-0): `behaviour: reprice` - after the first delivered call `tools/list` returns
 * `description` and the next challenge is `challenge`. */
export const RepriceSpecSchema = z.object({
  description: z.string().optional(),
  challenge: ChallengeSpecSchema,
});
export type RepriceSpec = z.infer<typeof RepriceSpecSchema>;

const RouteBaseSchema = z.object({
  host: z.string().default("provider.test"),
  // v6: optional only so a tool route may omit it; `RouteSchema` normalises it (below),
  // so a parsed `Route.path` is always a string.
  path: z.string().optional(),
  method: z.enum(["GET", "POST"]).default("GET"),
  page: z.string().optional(),
  content_type: z.string().default("text/markdown"),
  redirect: z.string().optional(),
  challenge: ChallengeSpecSchema.optional(),
  behaviour: z
    .enum([
      "normal",
      "402_forever",
      "no_delivery",
      "replay",
      "collect_signature",
      // v6 (U30-0): tool-only.
      "settle_fail",
      "reprice",
    ])
    .default("normal"),
  // v4 (U26-2, M2): required on, and only on, a `collect_signature` route.
  sign_request: SignRequestSpecSchema.optional(),
  delivered_body: z.string().optional(),
  // v3 (ADR-016 reach/`reached`): marks the route whose request presents the attack
  // (corpus/README.md documents the tagging convention). Optional, no default - a
  // scenario with `reach_class` but no `surface: true` route is a lint-rule-7 warning,
  // not an error, and its `reached` is `null`. Controls carry no `surface`.
  // v6 (U30-1): on a tool route also "description" (reached by a tools/list on the host)
  // or "result" (reached by a paid 200 tools/call of that tool); `true` on a tool route
  // means any tools/call of that name. The string forms are lint errors on other routes.
  surface: z.union([z.boolean(), z.enum(["description", "result"])]).optional(),
  // v6 (U30-0, ADR-034/035): optional, no default - a route without them parses to the
  // same JSON, so `corpusHash` is unchanged.
  tool: ToolSpecSchema.optional(),
  reprice: RepriceSpecSchema.optional(),
});

/**
 * v6 (U30-0): the single place a tool route's identity is normalised. A tool route is
 * always served at `POST /mcp`; its `path` may be omitted or `/mcp`, and its `method`
 * omitted or `POST` (anything else is a schema error below). Non-tool routes are
 * returned untouched.
 */
function normaliseToolRoute<T extends { tool?: unknown; path?: string | undefined }>(
  route: T,
): T & { path: string } {
  if (route.tool === undefined) return route as T & { path: string };
  return { ...route, path: MCP_PATH, method: "POST" } as T & { path: string };
}

/** A tool route's omitted `method` means POST: applied before the schema's GET default,
 * so an explicit `method: GET` on a tool route stays visible to the refine below. */
function defaultToolMethod(input: unknown): unknown {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>;
    if (obj.tool !== undefined && obj.method === undefined) return { ...obj, method: "POST" };
  }
  return input;
}

const RouteRefinedSchema = RouteBaseSchema.superRefine((route, ctx) => {
  const isTool = route.tool !== undefined;
  if (!isTool && route.path === undefined) {
    ctx.addIssue({ code: "custom", path: ["path"], message: "path is required on a route" });
  }
  if (isTool && route.path !== undefined && route.path !== MCP_PATH) {
    ctx.addIssue({
      code: "custom",
      path: ["path"],
      message: `a tool route's path must be absent or "${MCP_PATH}"`,
    });
  }
  if (isTool && route.method !== "POST") {
    ctx.addIssue({
      code: "custom",
      path: ["method"],
      message: "a tool route's method must be absent or POST",
    });
  }
  if (isTool && route.page !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["page"],
      message: "page is not allowed on a tool route",
    });
  }
  const toolOnly = route.behaviour === "settle_fail" || route.behaviour === "reprice";
  if (toolOnly && !isTool) {
    ctx.addIssue({
      code: "custom",
      path: ["behaviour"],
      message: `behaviour ${route.behaviour} is allowed only on a tool route`,
    });
  }
  if ((route.behaviour === "reprice") !== (route.reprice !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["reprice"],
      message: "reprice is required on, and only allowed on, a reprice route",
    });
  }
}).transform((route) => normaliseToolRoute(route));

export const RouteSchema = z.preprocess(defaultToolMethod, RouteRefinedSchema);
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
  // v4 (U26-2, B4): the guardrail-track driver fetches every 402 first and sends all the
  // GDP `payment` requests before awaiting any answer. Optional, no default, so existing
  // scenarios parse to the same JSON and `corpusHash` is unchanged.
  parallel: z.boolean().optional(),
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
  // v3 (ADR-016): required on every attack scenario, forbidden on "control" - enforced
  // by lint rule 7 (load.ts), not here, so the error carries a file/path (CorpusError).
  reach_class: ReachClassSchema.optional(),
  // v3 (ADR-014 rail port): defaults to "x402v2" - every scenario in this corpus speaks
  // x402 v2 until the rail port (U20) and a future scenario set this explicitly.
  rail: RailSchema.default("x402v2"),
  // v4 (U26-3, review M5): the real-world technique a scenario models inside its category
  // (e.g. "address_poisoning", "discovery_poisoning", "agent_lure"). Free text, optional,
  // no default (scenarios without it parse unchanged), and never aggregated: by_category,
  // SARIF and the leaderboard all key on `category` only.
  technique: z.string().min(1).optional(),
  // v6 (U30-0, ADR-035): which transport the scenario speaks. Optional with NO zod
  // default (a default would write `transport: "http"` into every parsed scenario and
  // move `corpusHash`); see `scenarioTransport()`.
  transport: TransportSchema.optional(),
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

/** True when a route marks an attack surface (`surface: true`, or v6's tool forms). */
export function isSurfaceRoute(route: { surface?: boolean | "description" | "result" }): boolean {
  return route.surface !== undefined && route.surface !== false;
}

/** v6 (U30-0): true for an MCP tool route. */
export function isToolRoute(route: { tool?: unknown }): boolean {
  return route.tool !== undefined;
}

/** v6 (U30-0, B2): the route identity of tool `name` on `host`: `<host>/mcp#<name>`. */
export function toolRouteKey(host: string, name: string): string {
  return `${host}${MCP_PATH}#${name}`;
}

/**
 * v6 (U30-0, B2): `<host>/mcp#<name>` for a tool route (so two tools on one host never
 * share challenge ids, delivery state or loop counts), `<host><path>` otherwise - the
 * same value the adversary uses for an HTTP route today.
 */
export function routeKeyFor(route: {
  host: string;
  path: string;
  tool?: { name: string } | undefined;
}): string {
  return route.tool === undefined
    ? `${route.host}${route.path}`
    : toolRouteKey(route.host, route.tool.name);
}
