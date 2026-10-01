/**
 * `guarded.ts`'s policy (application-design.md §8, U11 fixes), ported to GDP hooks
 * (ADR-010 §5 "reference-policy"): host in allowed_hosts, network matches the task,
 * `maxTimeoutSeconds` bounded, asset is this chain's USDC, per-payment and running-total
 * budget, the advertised price (from the referring page's text) isn't undercut, and at
 * most one payment per route with a stable `payTo`. Unlike `guarded.ts`, there is no
 * `resource.url` to be tricked by in the first place: GDP's `request.url` is always the
 * URL the driver actually requested (never anything the server claims about itself), so
 * the resource_spoof fix guarded.ts needed is simply the protocol's default here.
 * Implements `payment` and `transfer` (always deny - this policy never pays on prose).
 */
import { createInterface } from "node:readline";
import type {
  GdpHelloRequest,
  GdpPaymentRequest,
  GdpSignRequest,
  GdpTransferRequest,
} from "@x402-redteam/driver/protocol";
import { atomicToUsd, CHAIN_DEFAULTS, type Chain, DEFAULT_HOST } from "@x402-redteam/schema";

type Incoming = GdpHelloRequest | GdpPaymentRequest | GdpTransferRequest | GdpSignRequest;
type Accept = {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
};

const BUDGET_EPSILON = 1e-9;
const PRICE_TOLERANCE = 1.01;
const MAX_TIMEOUT_SECONDS = 900;
const HOST_PREFIX = "/_host/";

interface State {
  chain: Chain;
  network: string;
  budgetUsd: number;
  hostMode: string;
  allowedHosts: Set<string>;
  runningTotalUsd: number;
  paidRoutes: Set<string>;
  firstPayToByRoute: Map<string, string>;
}

let state: State | undefined;

function respond(body: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

function addressEquals(chain: Chain, a: string, b: string): boolean {
  return chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `path` mode encodes a virtual host as `/_host/<name>/<rest>`; every other mode
 * already puts the virtual host in the URL's hostname (ADR-012). */
function parseHostPath(url: string, hostMode: string): { host: string; path: string } {
  const u = new URL(url);
  if (hostMode !== "path") return { host: u.hostname.toLowerCase(), path: u.pathname };
  const pathname = u.pathname;
  if (pathname.startsWith(HOST_PREFIX)) {
    const trimmed = pathname.slice(HOST_PREFIX.length);
    const slash = trimmed.indexOf("/");
    return slash === -1
      ? { host: trimmed, path: "" }
      : { host: trimmed.slice(0, slash), path: trimmed.slice(slash) };
  }
  return { host: DEFAULT_HOST, path: pathname };
}

function routeKeyOf(hp: { host: string; path: string }): string {
  return `${hp.host}${hp.path}`;
}

/** The first `$<number>` mentioned in the referring page's text, or undefined. */
function advertisedPrice(text: string): number | undefined {
  const match = /\$\s*([\d.]+)/.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line) as Incoming;

  if (msg.type === "hello") {
    state = {
      chain: msg.task.chain,
      network: msg.task.network,
      budgetUsd: msg.task.budget_usd,
      hostMode: msg.task.host_mode,
      allowedHosts: new Set(msg.task.allowed_hosts.map((h) => h.toLowerCase())),
      runningTotalUsd: 0,
      paidRoutes: new Set(),
      firstPayToByRoute: new Map(),
    };
    respond({
      id: msg.id,
      hooks: ["payment", "transfer"],
      name: "reference-policy",
      version: "1.0.0",
      nondeterministic: false,
    });
    return;
  }
  if (!state) return;

  if (msg.type === "transfer") {
    respond({ id: msg.id, decision: "deny", reason: "reference-policy never pays on prose" });
    return;
  }
  if (msg.type !== "payment") return;

  const hp = parseHostPath(msg.request.url, state.hostMode);
  const routeKey = routeKeyOf(hp);

  if (!state.allowedHosts.has(hp.host.toLowerCase())) {
    respond({ id: msg.id, decision: "deny", reason: `host "${hp.host}" is not in allowed_hosts` });
    return;
  }

  const accepts = msg.challenge.accepts as Accept[];
  const acceptIndex = accepts.findIndex((a) => a.network === state?.network);
  const accept = acceptIndex === -1 ? undefined : accepts[acceptIndex];
  if (!accept) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `no accept matches network "${state.network}"`,
    });
    return;
  }

  if (accept.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `maxTimeoutSeconds ${accept.maxTimeoutSeconds} exceeds the ${MAX_TIMEOUT_SECONDS}s policy limit`,
    });
    return;
  }

  const defaults = CHAIN_DEFAULTS[state.chain];
  if (!addressEquals(state.chain, accept.asset, defaults.asset)) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `asset "${accept.asset}" is not this chain's USDC`,
    });
    return;
  }

  const amountUsd = atomicToUsd(accept.amount, defaults.decimals);
  if (amountUsd > state.budgetUsd + BUDGET_EPSILON) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `amount $${amountUsd} exceeds the per-payment budget $${state.budgetUsd}`,
    });
    return;
  }
  if (state.runningTotalUsd + amountUsd > state.budgetUsd + BUDGET_EPSILON) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `amount $${amountUsd} would exceed the remaining budget`,
    });
    return;
  }

  const advertised = advertisedPrice(msg.referrer?.text ?? "");
  if (advertised !== undefined && amountUsd > advertised * PRICE_TOLERANCE) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `amount $${amountUsd} exceeds the page's advertised price $${advertised}`,
    });
    return;
  }

  if (state.paidRoutes.has(routeKey)) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `route "${routeKey}" was already paid in this run`,
    });
    return;
  }

  const firstPayTo = state.firstPayToByRoute.get(routeKey);
  if (firstPayTo === undefined) {
    state.firstPayToByRoute.set(routeKey, accept.payTo);
  } else if (!addressEquals(state.chain, firstPayTo, accept.payTo)) {
    respond({
      id: msg.id,
      decision: "deny",
      reason: `payTo for route "${routeKey}" changed since its first challenge`,
    });
    return;
  }

  state.paidRoutes.add(routeKey);
  state.runningTotalUsd += amountUsd;
  respond({ id: msg.id, decision: "allow", accept_index: acceptIndex });
});
