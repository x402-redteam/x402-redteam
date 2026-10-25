import {
  acceptsForChain,
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  DEFAULT_HOST,
  type HostMode,
  hostUrl,
  type RenderContext,
  type Route,
  render,
  renderJsonStrings,
  routeKeyFor,
  type Scenario,
  type SignRequestBody,
  type SignRequestSpec,
  type SignRequestTypedData,
  type SignRequestWire,
} from "@x402-redteam/schema";

/** One resolved, rendered `accepts[]` entry (v1's single-option challenge resolves to a
 * 1-element list - see `acceptsForChain()` in schema). */
export interface RenderedAccept {
  amount_usd?: number;
  amount_atomic?: string;
  pay_to: string;
  network?: string;
  asset?: string;
  scheme: string;
  max_timeout_seconds: number;
  extra?: Record<string, unknown>;
}

/** A route's challenge with every templated field resolved, per application-design.md
 * §3 "v2": an ordered `accepts[]` (accepts_ordering), an optional `resource_url`
 * override (resource_spoof) and an optional deep-rendered `body_json` (challenge_injection). */
export interface RenderedChallenge {
  accepts: RenderedAccept[];
  resource_url?: string;
  body_json?: unknown;
  description?: string;
  /** v4 (U26-2): `PaymentRequired.extensions`, deep-rendered. */
  extensions?: Record<string, unknown>;
  /** v5 (U29-1, ADR-032): wire-level overrides; `patch` is deep-rendered, a `raw:`
   * encoding's string is rendered. */
  wire?: { patch?: Record<string, unknown>; encoding?: string; body?: "same" | "differs" | "none" };
}

/** v4 (U26-2, M2): a `collect_signature` route's rendered sign request. */
export interface RenderedSignRequest {
  status: 200 | 402;
  submit_path: string;
  /** The JSON body the route serves (application-design.md v4 sign-request shape). */
  body: SignRequestBody;
}

/** A route with every templated field resolved for one (scenario, chain, baseUrl) load. */
export interface RenderedRoute {
  host: string;
  path: string;
  method: "GET" | "POST";
  page?: string;
  content_type: string;
  redirect?: string;
  challenge?: RenderedChallenge;
  behaviour: Route["behaviour"];
  delivered_body?: string;
  route_key: string;
  sign_request?: RenderedSignRequest;
  /** v6 (U30-1): a rendered MCP tool (route is served at `POST /mcp`, keyed by tool name). */
  tool?: RenderedTool;
  /** v6 (U30-1): `behaviour: reprice`'s rendered post-delivery description and challenge. */
  reprice?: { description?: string; challenge: RenderedChallenge };
}

/** v6 (U30-1): an MCP tool with its templates resolved. */
export interface RenderedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface RenderedScenario {
  routes: RenderedRoute[];
  /** `${method} ${host}\u0000${path}` -> route, for exact lookup. */
  byKey: Map<string, RenderedRoute>;
  ctx: RenderContext;
  /** Every rendered `pay_to` plus every `{{canary.*}}` referenced anywhere in the scenario. */
  knownOwners: string[];
  /** v3 (ADR-012): the host mode this load was rendered under. */
  host_mode: HostMode;
  /** v4 (U26-2): `POST ${host}\u0000${submit_path}` -> the collect_signature route that
   * served the sign request. */
  submitRoutes: Map<string, RenderedRoute>;
  /** v6 (U30-1, B2): `${host}\u0000${tool name}` -> the tool route (never in `byKey`). */
  toolRoutes: Map<string, RenderedRoute>;
}

const CANARY_VAR_RE = /\{\{\s*canary\.([a-zA-Z0-9_-]+)\s*\}\}/g;
const POISON_VAR_RE = /\{\{\s*poison:([a-zA-Z0-9_.-]+)\s*\}\}/g;

/** v4 (U26-2, M4): every canary name a `{{poison:NAME}}` refers to, anywhere in the
 * scenario. Their poisoned addresses join `knownOwners`, so an SVM transfer to one's
 * token account resolves back to it. */
function collectPoisonNames(scenario: Scenario): string[] {
  return [
    ...new Set([...JSON.stringify(scenario).matchAll(POISON_VAR_RE)].map((m) => m[1] as string)),
  ];
}

function collectCanaryNames(text: string, out: Set<string>): void {
  for (const match of text.matchAll(CANARY_VAR_RE)) {
    out.add(match[1] as string);
  }
}

/** Walks an arbitrary JSON-like value (an unrendered `body_json`) collecting every
 * `{{canary.NAME}}` reference in its string leaves, mirroring schema/load.ts's own
 * body_json handling (a separate, parallel implementation - this package doesn't
 * depend on schema's internal lint helpers). */
function collectCanaryNamesInJson(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    collectCanaryNames(value, out);
  } else if (Array.isArray(value)) {
    for (const v of value) collectCanaryNamesInJson(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectCanaryNamesInJson(v, out);
    }
  }
}

/** @internal exported for tests. */
export function collectScenarioCanaryNames(scenario: Scenario): string[] {
  const names = new Set<string>();
  collectCanaryNames(scenario.task.prompt, names);
  for (const route of scenario.routes) {
    if (route.page !== undefined) collectCanaryNames(route.page, names);
    if (route.redirect !== undefined) collectCanaryNames(route.redirect, names);
    if (route.delivered_body !== undefined) collectCanaryNames(route.delivered_body, names);
    if (route.challenge?.pay_to !== undefined) collectCanaryNames(route.challenge.pay_to, names);
    if (route.challenge?.description !== undefined)
      collectCanaryNames(route.challenge.description, names);
    // v2 (resource_spoof): templated, may itself embed a canary reference.
    if (route.challenge?.resource_url !== undefined)
      collectCanaryNames(route.challenge.resource_url, names);
    // v2 (challenge_injection): every string leaf, deep.
    if (route.challenge?.body_json !== undefined)
      collectCanaryNamesInJson(route.challenge.body_json, names);
    // v5 (U29-1): canaries named in a wire patch or raw header are known owners too.
    if (route.challenge?.wire?.patch !== undefined)
      collectCanaryNamesInJson(route.challenge.wire.patch, names);
    if (
      route.challenge?.wire?.encoding?.startsWith("raw:") ||
      route.challenge?.wire?.encoding?.startsWith("raw_json:")
    )
      collectCanaryNames(route.challenge.wire.encoding, names);
    for (const override of Object.values(route.challenge?.per_chain ?? {})) {
      if (override?.pay_to !== undefined) collectCanaryNames(override.pay_to, names);
    }
    // v2 (accepts_ordering): each accepts[] entry's own pay_to and per_chain overrides.
    for (const accept of route.challenge?.accepts ?? []) {
      collectCanaryNames(accept.pay_to, names);
      for (const override of Object.values(accept.per_chain ?? {})) {
        if (override?.pay_to !== undefined) collectCanaryNames(override.pay_to, names);
      }
    }
    // v6 (U30-0, m1): tool text and the repriced challenge name owners too.
    if (route.tool !== undefined) {
      collectCanaryNames(route.tool.description, names);
      collectCanaryNamesInJson(route.tool.input_schema, names);
    }
    if (route.reprice !== undefined) {
      if (route.reprice.description !== undefined)
        collectCanaryNames(route.reprice.description, names);
      collectCanaryNamesInJson(route.reprice.challenge, names);
    }
  }
  if (scenario.expected.recipient !== undefined)
    collectCanaryNames(scenario.expected.recipient, names);
  return [...names];
}

export function routeKey(host: string, path: string): string {
  return `${host}${path}`;
}

function toolLookupKey(host: string, name: string): string {
  return `${host}\u0000${name}`;
}

function lookupKey(method: string, host: string, path: string): string {
  return `${method} ${host}\u0000${path}`;
}

/**
 * Code review item 2 (orchestrator decision): in scenario templates, `{{base_url}}`
 * means *the provider host's own URL* - `hostUrl(mode, baseUrl, DEFAULT_HOST)` - not the
 * harness's bare origin. In `path` mode this must stay byte-identical to today's plain
 * `baseUrl` (no `/_host/provider.test` prefix - `routes.ts`'s default-host fallback
 * already treats a bare, unprefixed path as `provider.test`, so adding the prefix would
 * change every rendered request path). Every other mode genuinely needs the rendered
 * form (`http://provider.test.localhost:<port>` etc.) so a request built from
 * `{{base_url}}/weather/today` actually carries the right `Host` header once
 * Host-header routing lands (U17). `task.base_url` (the TaskFile field used for harness
 * endpoints like `facilitator_url`) is a separate, unaffected value - see `task.ts`.
 */
function providerBaseUrl(hostMode: HostMode, baseUrl: string): string {
  return hostMode === "path" ? baseUrl : hostUrl(hostMode, baseUrl, DEFAULT_HOST);
}

function buildRenderContext(
  seed: string,
  scenarioId: string,
  chain: Chain,
  baseUrl: string,
  hostMode: HostMode,
): RenderContext {
  const scenarioCanaries = canaries(seed, scenarioId, chain);
  const defaults = CHAIN_DEFAULTS[chain];
  return {
    base_url: providerBaseUrl(hostMode, baseUrl),
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => hostUrl(hostMode, baseUrl, name),
    canary: (name: string) => scenarioCanaries.get(name).address,
    poison: (name: string) => scenarioCanaries.poison(name),
  };
}

/** v4 (U26-2): the served sign request; `submit_url` is the submit path on the route's
 * own host, rendered under the active host mode. */
function renderSignRequest(
  spec: SignRequestSpec,
  host: string,
  ctx: RenderContext,
): RenderedSignRequest {
  const r = (value: string) => render(value, ctx);
  const origin = host === DEFAULT_HOST ? ctx.base_url : ctx.host(host);
  const submit_url = `${origin}${spec.submit_path}`;
  let wire: SignRequestWire;
  if (spec.kind === "typed_data" && spec.typed_data !== undefined) {
    wire = {
      kind: "typed_data",
      typed_data: renderJsonStrings(spec.typed_data, ctx) as SignRequestTypedData,
      submit_url,
    };
  } else if (spec.kind === "digest" && spec.digest !== undefined) {
    wire = { kind: "digest", digest: r(spec.digest), submit_url };
  } else if (spec.kind === "message" && spec.message !== undefined) {
    wire = { kind: "message", message: r(spec.message), submit_url };
  } else if (spec.kind === "authorization" && spec.authorization !== undefined) {
    wire = {
      kind: "authorization",
      authorization: {
        chainId: spec.authorization.chain_id,
        address: r(spec.authorization.address),
        nonce: spec.authorization.nonce,
      },
      submit_url,
    };
  } else {
    // Unreachable for a scenario that passed SignRequestSpecSchema.
    throw new Error(`renderSignRequest: sign_request kind ${spec.kind} has no matching field`);
  }
  const body: SignRequestBody = {
    ...(spec.status === 402 ? { error: "signature_required" as const } : {}),
    ...(spec.text !== undefined ? { text: r(spec.text) } : {}),
    sign_request: wire,
  };
  return { status: spec.status, submit_path: spec.submit_path, body };
}

function renderWire(
  wire: NonNullable<Route["challenge"]>["wire"] & object,
  ctx: RenderContext,
): NonNullable<RenderedChallenge["wire"]> {
  return {
    ...(wire.patch !== undefined
      ? { patch: renderJsonStrings(wire.patch, ctx) as Record<string, unknown> }
      : {}),
    ...(wire.encoding !== undefined
      ? {
          encoding:
            wire.encoding.startsWith("raw:") || wire.encoding.startsWith("raw_json:")
              ? render(wire.encoding, ctx)
              : wire.encoding,
        }
      : {}),
    ...(wire.body !== undefined ? { body: wire.body } : {}),
  };
}

function renderChallenge(
  challenge: NonNullable<Route["challenge"]>,
  chain: Chain,
  ctx: RenderContext,
): RenderedChallenge {
  // v2 (accepts_ordering): resolves both the v1 single-option shape and v2's ordered
  // `accepts[]` to the same list - a v1 spec always resolves to one element.
  const accepts: RenderedAccept[] = acceptsForChain(challenge, chain).map((accept) => ({
    amount_usd: accept.amount_usd,
    amount_atomic: accept.amount_atomic,
    pay_to: render(accept.pay_to, ctx),
    network: accept.network,
    asset: accept.asset,
    scheme: accept.scheme,
    max_timeout_seconds: accept.max_timeout_seconds,
    extra: accept.extra,
  }));
  return {
    accepts,
    // v2 (resource_spoof): overrides PaymentRequired.resource.url.
    resource_url:
      challenge.resource_url !== undefined ? render(challenge.resource_url, ctx) : undefined,
    // v2 (challenge_injection): deep-rendered; every string leaf is templated.
    body_json:
      challenge.body_json !== undefined ? renderJsonStrings(challenge.body_json, ctx) : undefined,
    description:
      challenge.description !== undefined ? render(challenge.description, ctx) : undefined,
    // v4 (U26-2): deep-rendered like body_json.
    ...(challenge.extensions !== undefined
      ? { extensions: renderJsonStrings(challenge.extensions, ctx) as Record<string, unknown> }
      : {}),
    ...(challenge.wire !== undefined ? { wire: renderWire(challenge.wire, ctx) } : {}),
  };
}

function renderRoute(route: Route, chain: Chain, ctx: RenderContext): RenderedRoute {
  const rendered: RenderedRoute = {
    host: route.host,
    path: route.path,
    method: route.method,
    content_type: route.content_type,
    behaviour: route.behaviour,
    route_key: routeKeyFor(route),
  };
  if (route.page !== undefined) rendered.page = render(route.page, ctx);
  if (route.redirect !== undefined) rendered.redirect = render(route.redirect, ctx);
  if (route.delivered_body !== undefined)
    rendered.delivered_body = render(route.delivered_body, ctx);
  if (route.challenge !== undefined) {
    rendered.challenge = renderChallenge(route.challenge, chain, ctx);
  }
  if (route.tool !== undefined) {
    rendered.tool = {
      name: route.tool.name,
      description: render(route.tool.description, ctx),
      input_schema: renderJsonStrings(route.tool.input_schema, ctx) as Record<string, unknown>,
    };
  }
  if (route.reprice !== undefined) {
    rendered.reprice = {
      ...(route.reprice.description !== undefined
        ? { description: render(route.reprice.description, ctx) }
        : {}),
      challenge: renderChallenge(route.reprice.challenge, chain, ctx),
    };
  }
  if (route.sign_request !== undefined) {
    rendered.sign_request = renderSignRequest(route.sign_request, route.host, ctx);
  }
  return rendered;
}

/**
 * Renders every route in the scenario once, at `load()` time, per functional-design.md
 * §2. `hostMode` defaults to "path" (U15, Bolt 6 Phase A) - the key rule that keeps
 * path-mode `report.json` byte-compatible (U15 functional-design.md §3); U17 is the one
 * that actually threads a non-default mode through from the CLI.
 */
export function renderScenario(
  scenario: Scenario,
  chain: Chain,
  baseUrl: string,
  seed: string,
  hostMode: HostMode = "path",
): RenderedScenario {
  const ctx = buildRenderContext(seed, scenario.id, chain, baseUrl, hostMode);
  const routes = scenario.routes.map((route) => renderRoute(route, chain, ctx));
  const byKey = new Map<string, RenderedRoute>();
  const submitRoutes = new Map<string, RenderedRoute>();
  const toolRoutes = new Map<string, RenderedRoute>();
  for (const route of routes) {
    if (route.tool !== undefined) {
      // v6 (B2): a tool route is looked up by (host, tool name), never by path.
      toolRoutes.set(toolLookupKey(route.host, route.tool.name), route);
      continue;
    }
    byKey.set(lookupKey(route.method, route.host, route.path), route);
    if (route.sign_request !== undefined) {
      submitRoutes.set(lookupKey("POST", route.host, route.sign_request.submit_path), route);
    }
  }
  const owners = new Set<string>();
  for (const name of collectScenarioCanaryNames(scenario)) {
    owners.add(ctx.canary(name));
  }
  for (const name of collectPoisonNames(scenario)) {
    owners.add(ctx.poison(name));
  }
  for (const route of routes) {
    // v2 (accepts_ordering): every entry's payTo, not just a single one.
    for (const accept of route.challenge?.accepts ?? []) owners.add(accept.pay_to);
    for (const accept of route.reprice?.challenge.accepts ?? []) owners.add(accept.pay_to);
  }
  return {
    routes,
    byKey,
    ctx,
    knownOwners: [...owners],
    host_mode: hostMode,
    submitRoutes,
    toolRoutes,
  };
}

/** v4 (U26-2): the collect_signature route whose sign request POSTs to (host, path). */
export function findSubmitRoute(
  rendered: RenderedScenario,
  method: string,
  host: string,
  path: string,
): RenderedRoute | undefined {
  return rendered.submitRoutes.get(lookupKey(method, host, path));
}

export function findRoute(
  rendered: RenderedScenario,
  method: string,
  host: string,
  path: string,
): RenderedRoute | undefined {
  return rendered.byKey.get(lookupKey(method, host, path));
}

/** v6 (U30-1, B2): the tool route named `name` on `host`. */
export function findTool(
  rendered: RenderedScenario,
  host: string,
  name: string,
): RenderedRoute | undefined {
  return rendered.toolRoutes.get(toolLookupKey(host, name));
}

/** v6 (U30-1): the tool routes on `host`, in scenario order. */
export function toolsOnHost(rendered: RenderedScenario, host: string): RenderedRoute[] {
  return rendered.routes.filter((r) => r.tool !== undefined && r.host === host);
}
