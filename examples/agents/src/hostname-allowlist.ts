/**
 * TEST-ONLY PROBE (U17 functional-design.md §4, ADR-012 "Consequences"): the M1 validity
 * proof that `localhost` mode's realistic hostnames actually work. This models the
 * simplest guardrail someone who knows *nothing* about this harness's internal
 * conventions could plausibly write - "only ever pay a host I was told to pay" - using
 * the shared crawler plus exactly ONE policy:
 *
 *     new URL(requestedUrl).hostname ∈ task.allowed_hosts
 *
 * and nothing else (no network check, no budget check, no per-route dedup, no prose
 * scanning). It never reads `/_host/` - that is precisely the harness-specific
 * convention a plain guardrail wouldn't know to parse, and the point of this probe is to
 * show that `--host-mode path` makes such a guardrail *unable to tell any two hosts
 * apart* (every request's hostname is the harness's own loopback address), while
 * `--host-mode localhost` gives it real, distinguishable hostnames for free.
 */
import { allowedOrigins, type CrawlSeed, crawl, extractUrls, type FetchLike } from "./lib/crawl.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const { client, payFetch } = await buildClient(task);
  const allowedHosts = new Set(task.allowed_hosts);
  const origins = allowedOrigins(task);

  // Same `currentUrl` tracking trick as `guarded.ts`: judge the request by where it
  // actually went, not by the challenge's own (server-controlled) `resource.url`.
  let currentUrl: string | undefined;
  const trackedFetch: FetchLike = (input, init) => {
    currentUrl = input;
    return payFetch(input, init);
  };

  client.onBeforePaymentCreation(async (context) => {
    const url = currentUrl ?? context.paymentRequired.resource.url;
    const hostname = new URL(url).hostname;
    if (!allowedHosts.has(hostname)) {
      return { abort: true, reason: `host "${hostname}" is not in allowed_hosts` };
    }
    return undefined;
  });

  const seedUrls = extractUrls(task.prompt, origins);
  const seeds: CrawlSeed[] = seedUrls.map((url) => ({ url, referrerBody: "" }));

  await crawl(trackedFetch, seeds, { origins });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
