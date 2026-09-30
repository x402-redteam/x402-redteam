import {
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  challengeForChain,
  type RenderContext,
  type Route,
  render,
  type Scenario,
} from "@x402-redteam/schema";

/** A route with every templated field resolved for one (scenario, chain, baseUrl) load. */
export interface RenderedRoute {
  host: string;
  path: string;
  method: "GET" | "POST";
  page?: string;
  content_type: string;
  redirect?: string;
  challenge?: {
    amount_usd?: number;
    amount_atomic?: string;
    pay_to: string;
    network?: string;
    asset?: string;
    scheme: string;
    max_timeout_seconds: number;
    extra?: Record<string, unknown>;
    description?: string;
  };
  behaviour: "normal" | "402_forever" | "no_delivery" | "replay";
  delivered_body?: string;
  route_key: string;
}

export interface RenderedScenario {
  routes: RenderedRoute[];
  /** `${method} ${host}\u0000${path}` -> route, for exact lookup. */
  byKey: Map<string, RenderedRoute>;
  ctx: RenderContext;
  /** Every rendered `pay_to` plus every `{{canary.*}}` referenced anywhere in the scenario. */
  knownOwners: string[];
}

const CANARY_VAR_RE = /\{\{\s*canary\.([a-zA-Z0-9_-]+)\s*\}\}/g;

function collectCanaryNames(text: string, out: Set<string>): void {
  for (const match of text.matchAll(CANARY_VAR_RE)) {
    out.add(match[1] as string);
  }
}

function collectScenarioCanaryNames(scenario: Scenario): string[] {
  const names = new Set<string>();
  collectCanaryNames(scenario.task.prompt, names);
  for (const route of scenario.routes) {
    if (route.page !== undefined) collectCanaryNames(route.page, names);
    if (route.redirect !== undefined) collectCanaryNames(route.redirect, names);
    if (route.delivered_body !== undefined) collectCanaryNames(route.delivered_body, names);
    if (route.challenge?.pay_to !== undefined) collectCanaryNames(route.challenge.pay_to, names);
    if (route.challenge?.description !== undefined)
      collectCanaryNames(route.challenge.description, names);
    for (const override of Object.values(route.challenge?.per_chain ?? {})) {
      if (override?.pay_to !== undefined) collectCanaryNames(override.pay_to, names);
    }
  }
  if (scenario.expected.recipient !== undefined)
    collectCanaryNames(scenario.expected.recipient, names);
  return [...names];
}

export function routeKey(host: string, path: string): string {
  return `${host}${path}`;
}

function lookupKey(method: string, host: string, path: string): string {
  return `${method} ${host}\u0000${path}`;
}

function buildRenderContext(
  seed: string,
  scenarioId: string,
  chain: Chain,
  baseUrl: string,
): RenderContext {
  const scenarioCanaries = canaries(seed, scenarioId, chain);
  const defaults = CHAIN_DEFAULTS[chain];
  return {
    base_url: baseUrl,
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => `${baseUrl}/_host/${name}`,
    canary: (name: string) => scenarioCanaries.get(name).address,
  };
}

function renderRoute(route: Route, chain: Chain, ctx: RenderContext): RenderedRoute {
  const rendered: RenderedRoute = {
    host: route.host,
    path: route.path,
    method: route.method,
    content_type: route.content_type,
    behaviour: route.behaviour,
    route_key: routeKey(route.host, route.path),
  };
  if (route.page !== undefined) rendered.page = render(route.page, ctx);
  if (route.redirect !== undefined) rendered.redirect = render(route.redirect, ctx);
  if (route.delivered_body !== undefined)
    rendered.delivered_body = render(route.delivered_body, ctx);
  if (route.challenge !== undefined) {
    const resolved = challengeForChain(route.challenge, chain);
    // v2 (application-design.md §3 "v2"): ChallengeSpec.pay_to is now optional (a
    // challenge may set `accepts` instead) - this render path is v1-only until U11
    // wires up accepts-aware rendering, and every v1 scenario always sets pay_to.
    if (resolved.pay_to === undefined) {
      throw new Error(
        `renderRoute: route "${rendered.route_key}" challenge has no pay_to (accepts-based challenges are not yet rendered here)`,
      );
    }
    rendered.challenge = {
      amount_usd: resolved.amount_usd,
      amount_atomic: resolved.amount_atomic,
      pay_to: render(resolved.pay_to, ctx),
      network: resolved.network,
      asset: resolved.asset,
      scheme: resolved.scheme,
      max_timeout_seconds: resolved.max_timeout_seconds,
      extra: resolved.extra,
      description:
        resolved.description !== undefined ? render(resolved.description, ctx) : undefined,
    };
  }
  return rendered;
}

/** Renders every route in the scenario once, at `load()` time, per functional-design.md §2. */
export function renderScenario(
  scenario: Scenario,
  chain: Chain,
  baseUrl: string,
  seed: string,
): RenderedScenario {
  const ctx = buildRenderContext(seed, scenario.id, chain, baseUrl);
  const routes = scenario.routes.map((route) => renderRoute(route, chain, ctx));
  const byKey = new Map<string, RenderedRoute>();
  for (const route of routes) {
    byKey.set(lookupKey(route.method, route.host, route.path), route);
  }
  const owners = new Set<string>();
  for (const name of collectScenarioCanaryNames(scenario)) {
    owners.add(ctx.canary(name));
  }
  for (const route of routes) {
    if (route.challenge) owners.add(route.challenge.pay_to);
  }
  return { routes, byKey, ctx, knownOwners: [...owners] };
}

export function findRoute(
  rendered: RenderedScenario,
  method: string,
  host: string,
  path: string,
): RenderedRoute | undefined {
  return rendered.byKey.get(lookupKey(method, host, path));
}
