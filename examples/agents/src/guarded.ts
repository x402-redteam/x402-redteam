/**
 * The guarded reference agent, per application-design.md §8 / U5
 * functional-design.md §5, updated by U11 functional-design.md §5 (Bolt 5): the same
 * crawler as `naive`, but every payment must clear an `onBeforePaymentCreation` policy
 * before the x402 client is allowed to sign it. It never scans page prose, never
 * retries a paid 402 (each URL is fetched exactly once), and the policy refuses to pay
 * the same route twice in a run. No LLM is involved.
 *
 * U11 additions (resource_spoof, accepts_ordering, authorization_lifetime - Review 1
 * B2 / application-design.md §3 "v2"):
 *  - the host check is judged against the URL this agent actually requested
 *    (`currentUrl`, tracked via a wrapper around `payFetch`), not
 *    `PaymentCreationContext.paymentRequired.resource.url`, which the server fully
 *    controls and may misrepresent;
 *  - a client-side policy keeps only `accepts[]` entries on the task's own network,
 *    so list order alone can't select a mainnet rail;
 *  - `maxTimeoutSeconds` above a fixed ceiling is refused outright.
 *
 * U17 addition (ADR-012, realistic hostnames): the host check (`parseHostPath`, now
 * shared with `obedient.ts` via `./lib/host-check.js` - code review F3) is mode-aware:
 * in `localhost`/`proxy` mode it's the generic `new URL(requested).hostname` - exactly
 * what a guardrail that knows nothing about this harness would write - compared against
 * `task.allowed_hosts` (already rendered to match, e.g. `"provider.test.localhost"`).
 * `path` mode keeps the pre-ADR-012 `/_host/` convention - see `lib/host-check.ts` for
 * why that branch exists rather than being deleted outright. `hostname-allowlist.ts` is
 * the literal, mode-naive version of this check - its whole purpose is to prove path
 * mode fails it (ADR-012's M1 validity proof). The crawler itself (`lib/crawl.ts`) is a
 * separate, origin-allowlist-based safety net (code review F1) - unrelated to this
 * mode-aware *policy* check.
 */
import { atomicToUsd, CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { allowedOrigins, type CrawlSeed, crawl, extractUrls, type FetchLike } from "./lib/crawl.js";
import { type HostPath, parseHostPath } from "./lib/host-check.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

const BUDGET_EPSILON = 1e-9;
const PRICE_TOLERANCE = 1.01;
/** authorization_lifetime: refuse a signature window longer than this, regardless of
 * price or recipient - application-design.md §3 "v2" `max_authorization_seconds`. */
const MAX_TIMEOUT_SECONDS = 900;

function routeKeyOf(hp: HostPath): string {
  return `${hp.host}${hp.path}`;
}

function addressEquals(a: string, b: string, chain: "evm" | "svm"): boolean {
  return chain === "evm" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The first `$<number>` mentioned in a page's text, or undefined if none. */
function advertisedPrice(text: string): number | undefined {
  const match = /\$\s*([\d.]+)/.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const { client, payFetch } = await buildClient(task);

  const defaults = CHAIN_DEFAULTS[task.chain];
  const allowedHosts = new Set(task.allowed_hosts);
  const origins = allowedOrigins(task);

  // Empty string means "no advertised price known yet" - seeds start this way (the task
  // prompt's own budget mention isn't a page's advertised price); a link discovered inside
  // an actual fetched page's body overwrites it with that page's text.
  const referrerBodyByUrl = new Map<string, string>();
  const paidRoutes = new Set<string>();
  const firstPayToByRoute = new Map<string, string>();
  let runningTotalUsd = 0;

  // resource_spoof fix: the crawler only ever calls `payFetch` through this wrapper, so
  // `currentUrl` always holds the URL this agent actually sent the request to by the
  // time `onBeforePaymentCreation` fires - that hook runs synchronously inside the same
  // `payFetch` call that observes the 402 and decides whether to pay it.
  let currentUrl: string | undefined;
  const trackedFetch: FetchLike = (input, init) => {
    currentUrl = input;
    return payFetch(input, init);
  };

  // accepts_ordering fix: keep only the accepts[] entries on the task's own network
  // before the client's default selector (which just takes the first surviving entry)
  // ever runs, so list order can't put the agent on a rail the task never asked for.
  client.registerPolicy((_x402Version, requirements) =>
    requirements.filter((r) => r.network === task.network),
  );

  client.onBeforePaymentCreation(async (context) => {
    const req = context.selectedRequirements;
    // resource_spoof fix: judge the request by where it actually went, not by what the
    // challenge's own (server-controlled) resource.url claims.
    const url = currentUrl ?? context.paymentRequired.resource.url;
    const hp = parseHostPath(url, task);
    const routeKey = routeKeyOf(hp);

    if (!allowedHosts.has(hp.host)) {
      return { abort: true, reason: `host "${hp.host}" is not in allowed_hosts` };
    }
    if (req.network !== task.network) {
      return { abort: true, reason: `network "${req.network}" does not match task network` };
    }
    if (req.maxTimeoutSeconds > MAX_TIMEOUT_SECONDS) {
      return {
        abort: true,
        reason: `maxTimeoutSeconds ${req.maxTimeoutSeconds} exceeds the ${MAX_TIMEOUT_SECONDS}s policy limit`,
      };
    }
    if (!addressEquals(req.asset, defaults.asset, task.chain)) {
      return { abort: true, reason: `asset "${req.asset}" is not this chain's USDC` };
    }

    const amountUsd = atomicToUsd(req.amount, defaults.decimals);
    if (amountUsd > task.budget_usd + BUDGET_EPSILON) {
      return {
        abort: true,
        reason: `amount $${amountUsd} exceeds the per-payment budget $${task.budget_usd}`,
      };
    }
    if (runningTotalUsd + amountUsd > task.budget_usd + BUDGET_EPSILON) {
      return { abort: true, reason: `amount $${amountUsd} would exceed the remaining budget` };
    }

    const referrer = referrerBodyByUrl.get(url) ?? "";
    const advertised = advertisedPrice(referrer);
    if (advertised !== undefined && amountUsd > advertised * PRICE_TOLERANCE) {
      return {
        abort: true,
        reason: `amount $${amountUsd} exceeds the page's advertised price $${advertised}`,
      };
    }

    if (paidRoutes.has(routeKey)) {
      return { abort: true, reason: `route "${routeKey}" was already paid in this run` };
    }

    const firstPayTo = firstPayToByRoute.get(routeKey);
    if (firstPayTo === undefined) {
      firstPayToByRoute.set(routeKey, req.payTo);
    } else if (!addressEquals(firstPayTo, req.payTo, task.chain)) {
      return {
        abort: true,
        reason: `payTo for route "${routeKey}" changed since its first challenge`,
      };
    }

    paidRoutes.add(routeKey);
    runningTotalUsd += amountUsd;
    return undefined;
  });

  const seedUrls = extractUrls(task.prompt, origins);
  const seeds: CrawlSeed[] = seedUrls.map((url) => ({ url, referrerBody: "" }));

  await crawl(trackedFetch, seeds, {
    origins,
    onDiscover: (url, referrerBody) => {
      const existing = referrerBodyByUrl.get(url);
      if (existing === undefined || (existing === "" && referrerBody !== "")) {
        referrerBodyByUrl.set(url, referrerBody);
      }
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
