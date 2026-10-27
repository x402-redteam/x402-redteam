import { parsePaymentRequired } from "@x402/core/schemas";
import { CHAIN_DEFAULTS, type Chain, type McpChannel, type Scenario } from "@x402-redteam/schema";
import { railFor } from "./rails/index.js";
import { renderScenario } from "./render.js";
import { type ChannelPlan, planChannels, planOffers } from "./transports/mcp.js";

/** The longest paid-call timer `@x402/mcp` 2.28.0 allows (`maxRequestTimeoutSeconds`, 600). */
const MAX_REQUEST_TIMEOUT_SECONDS = 600;

/** What an MCP scenario's tool route serves, per channel (U30-4): a pure function of
 * (scenario, chain, seed), with no server. */
export interface OfferedMcpTerms {
  route_key: string;
  /** The first tool route's patched `accepts` as `both` would serve it: readable list or
   * null, and the value as served (any JSON type; null when absent). Equal to the HTTP
   * header's `accepts` for the same patch, so the page and mcp hashes agree. */
  accepts: unknown[] | null;
  rawAccepts: unknown;
  /** `standard`: an MCP object has no header encoding. */
  encoding: "standard";
  /** The `wire.channels` mode, `both` when absent. */
  mode: string;
  /** Each channel that carried a JSON object: its `accepts` as served (null when absent).
   * Present for every mode, `both` included; the manifest records the by-channel hashes
   * only for a mode that is not `both`. */
  channels: Partial<Record<McpChannel, { accepts: unknown }>>;
  /** Per channel: whether the served object passes `@x402/core` 2.28.0's
   * `parsePaymentRequired` (the zod validation `@x402/mcp` applies; D6). */
  sdk_schema_ok: Partial<Record<McpChannel, boolean>>;
  /** The paid call's timer in ms, from the channel `@x402/mcp` reads and the entry its
   * client would pick; null when it reads no valid challenge (D8, N4). */
  paid_timeout_ms: number | null;
  /** The JSON-RPC error code, for a `jsonrpc*` mode. */
  error_code?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type PaymentRequiredData = {
  accepts: {
    network: string;
    scheme: string;
    asset: string;
    amount: string;
    maxTimeoutSeconds: number;
  }[];
};

/**
 * The challenge `@x402/mcp` 2.28.0 would take from this answer, per its documented order
 * (u30-4-delta §1): on a tool result with `isError`, `structuredContent` if it validates,
 * else `content[0]` if it is a text item holding a JSON object that validates; on a
 * JSON-RPC error with code 402 or -32042, `data.x402` when the key exists (both codes),
 * else `data`. The MCP SDK rewrites a -32042 error that carries `elicitations`, so none is
 * read from it. Returns the schema-parsed (stripped) object, or null.
 */
function readByX402Mcp(plan: ChannelPlan): PaymentRequiredData | null {
  const parse = (value: unknown): PaymentRequiredData | null => {
    const r = parsePaymentRequired(value);
    return r.success ? (r.data as unknown as PaymentRequiredData) : null;
  };
  if (plan.error !== undefined) {
    if (plan.mode === "jsonrpc_elicit") return null;
    const { code, data } = plan.error;
    if (!isObject(data)) return null;
    // Both codes: `data.x402` whenever that key exists, else `data` (index.mjs:768-775).
    if (code === 402) {
      return "x402Version" in data && "accepts" in data
        ? parse("x402" in data ? data.x402 : data)
        : null;
    }
    if (code === -32042) {
      if ("x402Version" in data && "accepts" in data) {
        return parse("x402" in data ? data.x402 : data);
      }
      const ns = data.x402;
      if (isObject(ns) && "x402Version" in ns && "accepts" in ns) return parse(ns);
    }
    return null;
  }
  const result = plan.result;
  if (result === undefined || !result.isError) return null;
  // The MCP SDK rejects the whole result when `structuredContent` is present and not an
  // object (types.js:1302), so `@x402/mcp` reads nothing.
  if (result.structuredContent !== undefined && !isObject(result.structuredContent)) return null;
  if (result.structuredContent) {
    const read = parse(result.structuredContent);
    if (read !== null) return read;
  }
  const content = result.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const first: unknown = content[0];
  if (!isObject(first) || first.type !== "text" || typeof first.text !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(first.text);
    return isObject(parsed) ? parse(parsed) : null;
  } catch {
    return null;
  }
}

/** The `$1` default per-payment cap, in the default asset's atomic units (6 decimals). */
const DEFAULT_CAP_ATOMIC = 1_000_000n;

/** Whether `@x402/core`'s default spend controls let this entry through. */
function passesDefaultSpendControls(
  entry: PaymentRequiredData["accepts"][number],
  chain: Chain,
): boolean {
  // Default-asset allowlist (core client/index.mjs:507-518): the entry's asset must be the
  // scheme's default asset for its network. The harness signs on its own test network.
  const defaults = CHAIN_DEFAULTS[chain];
  if (entry.network !== defaults.network) return false;
  if (
    typeof entry.asset !== "string" ||
    entry.asset.toLowerCase() !== defaults.asset.toLowerCase()
  ) {
    return false;
  }
  // The default `$1` cap (DEFAULT_MAX_AMOUNT_PER_PAYMENT, :21; filter :520-553): an atomic
  // amount must be at most 1_000_000 units, a non-atomic one is compared as dollars.
  const amount = entry.amount;
  if (typeof amount !== "string") return false;
  if (/^\d+$/.test(amount)) return BigInt(amount) <= DEFAULT_CAP_ATOMIC;
  const dollars = Number(amount);
  return Number.isFinite(dollars) && dollars <= 1;
}

/**
 * `@x402/mcp`'s paid-call timer for the entry its EVM `exact` client would sign. Mirrors
 * `x402Client.selectPaymentRequirements` (@x402/core 2.28.0 client/index.mjs:442-484): keep
 * the entries with a registered scheme (eip155 `exact`), drop those the default spend
 * controls reject (`applySpendControls`, :495-571), then the default selector takes the
 * first remaining (`accepts[0]`, :75).
 */
function paidTimeoutMs(read: PaymentRequiredData | null, chain: Chain): number | null {
  const entry = read?.accepts
    .filter((a) => a.network.startsWith("eip155:") && a.scheme === "exact")
    .find((a) => passesDefaultSpendControls(a, chain));
  if (entry === undefined) return null;
  return Math.floor(Math.min(entry.maxTimeoutSeconds, MAX_REQUEST_TIMEOUT_SECONDS) * 1000);
}

/**
 * What the first challenged tool route of an `mcp` scenario serves (U30-4, D4): the manifest
 * hashes `rawAccepts` and each `channels` entry, and a test starts the adversary and checks
 * the same values are served. Uses the route's own `buildChallenge`, then the same
 * `planChannels` the server calls, so the two cannot drift.
 */
export function offeredMcpTermsForScenario(
  scenario: Scenario,
  chain: Chain,
  seed: string,
): OfferedMcpTerms | null {
  const rendered = renderScenario(scenario, chain, "http://127.0.0.1:0", seed);
  const route = rendered.routes.find((r) => r.challenge !== undefined && r.tool !== undefined);
  if (route === undefined || route.tool === undefined) return null;
  const rail = railFor(scenario.rail, scenario.id);
  if (rail.buildChallenge === undefined) return null;
  const built = rail.buildChallenge({
    route,
    chain,
    seed,
    scenarioAssets: scenario.assets,
    url: `mcp://tool/${route.tool.name}`,
    challenge_id: `${route.route_key}#1`,
    seq: 0,
  });
  const wire = route.challenge?.wire ?? {};
  const plan = planChannels(built.paymentRequired, wire, scenario.id);
  const channels = planOffers(plan);
  const sdk_schema_ok: Partial<Record<McpChannel, boolean>> = {};
  for (const [channel, object] of Object.entries(plan.served) as [McpChannel, unknown][]) {
    sdk_schema_ok[channel] = parsePaymentRequired(object).success;
  }
  const patchedAccepts = plan.patched.accepts;
  return {
    route_key: route.route_key,
    accepts: Array.isArray(patchedAccepts) ? (patchedAccepts as unknown[]) : null,
    rawAccepts: patchedAccepts === undefined ? null : patchedAccepts,
    encoding: "standard",
    mode: wire.channels ?? "both",
    channels,
    sdk_schema_ok,
    paid_timeout_ms: paidTimeoutMs(readByX402Mcp(plan), chain),
    ...(plan.error !== undefined ? { error_code: plan.error.code } : {}),
  };
}
