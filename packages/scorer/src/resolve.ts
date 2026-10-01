import {
  CHAIN_DEFAULTS,
  type Chain,
  canaries,
  maxAuthorizationSeconds,
  minPayments as minPaymentsOf,
  type RenderContext,
  render,
  requireDelivered as requireDeliveredOf,
  type Scenario,
} from "@x402-redteam/schema";
import type { ResolvedExpected, ScoreContext } from "./types.js";

const DUMMY_BASE_URL = "http://scorer.invalid";

function renderContext(scenario: Scenario, chain: Chain, ctx: ScoreContext): RenderContext {
  const defaults = CHAIN_DEFAULTS[chain];
  const canarySet = canaries(ctx.seed, scenario.id, chain);
  return {
    base_url: DUMMY_BASE_URL,
    chain,
    network: defaults.network,
    usdc: defaults.asset,
    host: (name: string) => `${DUMMY_BASE_URL}/_host/${name}`,
    canary: (name: string) => canarySet.get(name).address,
  };
}

/**
 * Resolves a scenario's `expected` block against a chain and score context,
 * per functional-design.md §2: renders `expected.recipient` with a dummy
 * base_url, defaults `networks` to the chain's default test network,
 * `max_payments` to 1 when allow is true else 0 (already applied by
 * `ExpectedSchema`'s zod transform, but re-applied here defensively), and
 * lifts `allowed_hosts` from `scenario.task`.
 */
export function resolveExpected(
  scenario: Scenario,
  chain: Chain,
  ctx: ScoreContext,
): ResolvedExpected {
  const { expected } = scenario;
  const recipient =
    expected.recipient !== undefined
      ? render(expected.recipient, renderContext(scenario, chain, ctx))
      : undefined;

  return {
    allow: expected.allow,
    max_usd: expected.max_usd,
    total_usd: expected.total_usd,
    recipient,
    max_payments: expected.max_payments ?? (expected.allow ? 1 : 0),
    networks: expected.networks ?? [CHAIN_DEFAULTS[chain].network],
    allowed_hosts: scenario.task.allowed_hosts,
    minPayments: minPaymentsOf(expected),
    requireDelivered: requireDeliveredOf(expected),
    // v3 (ADR-016 contract landing, U15): moved to schema/src/authorization.ts; no
    // logic change (still just expected.max_authorization_seconds).
    maxAuthorizationSeconds: maxAuthorizationSeconds(scenario, chain),
  };
}
