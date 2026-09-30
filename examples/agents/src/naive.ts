/**
 * The naive reference agent, per application-design.md §8 / U5
 * functional-design.md §5: crawls every URL it can reach from the task
 * prompt, pays every 402 it meets via `wrapFetchWithPayment` (retrying up to
 * 5 times when a route keeps 402ing, or "delivers" an empty body, after being
 * paid), and additionally scans page prose for a direct-transfer instruction
 * and sends it via the capture shim. No LLM is involved - this models a
 * maximally gullible payment client.
 */
import { recordTransfer } from "@x402-redteam/capture";
import { CHAIN_DEFAULTS, usdToAtomic } from "@x402-redteam/schema";
import { type CrawlSeed, crawl, extractUrls, type FetchLike } from "./lib/crawl.js";
import { buildClient, readTask, walletSecret } from "./lib/wallet.js";

const MAX_RETRIES = 5;

const PROSE_RE = /pay\s+\$?([\d.]+)[^\n]*?\bto\s+([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})/i;

/** A paid response is worth retrying (fresh top-level payFetch) when it's still a 402
 * after paying, or when it "delivered" an empty body - functional-design.md §5 /
 * architect note on retry-storm and fake-delivery. */
async function shouldRetry(res: Response): Promise<boolean> {
  if (res.status === 402) return true;
  if (res.status === 200) {
    const body = await res.clone().text();
    return body.length === 0;
  }
  return false;
}

function withRetries(payFetch: FetchLike): FetchLike {
  return async (input, init) => {
    let res = await payFetch(input, init);
    for (let attempt = 1; attempt < MAX_RETRIES && (await shouldRetry(res)); attempt++) {
      res = await payFetch(input, init);
    }
    return res;
  };
}

async function main(): Promise<void> {
  const task = readTask();
  const { payFetch } = await buildClient(task, { unlimitedSpend: true });
  const fetchWithRetries = withRetries(payFetch);

  // Fetch every prompt URL twice (fresh top-level attempts): a naive agent that "double
  // checks" a result, or that follows a prompt asking it to re-fetch, will hit a `replay`
  // route's reissued challenge - functional-design.md §5 / architect note on replay.
  const seedUrls = extractUrls(task.prompt, task.base_url);
  const seeds: CrawlSeed[] = seedUrls.flatMap((url) => [
    { url, referrerBody: task.prompt },
    { url, referrerBody: task.prompt },
  ]);

  const pages = await crawl(fetchWithRetries, seeds, { baseUrl: task.base_url });

  const defaults = CHAIN_DEFAULTS[task.chain];
  const secret = walletSecret(task);

  for (const page of pages) {
    const match = PROSE_RE.exec(page.body);
    if (!match) continue;
    const amountUsd = Number(match[1]);
    const to = match[2];
    if (!Number.isFinite(amountUsd) || !to) continue;

    try {
      await recordTransfer({
        chain: task.chain,
        ledgerUrl: task.ledger_url,
        secret,
        to,
        amount_atomic: usdToAtomic(amountUsd, defaults.decimals),
        asset: defaults.asset,
        network: defaults.network,
      });
    } catch (err) {
      console.error(`naive: recordTransfer failed for ${page.url}:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
