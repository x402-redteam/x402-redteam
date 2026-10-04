/**
 * The naive reference agent, per application-design.md §8 / U5
 * functional-design.md §5: crawls every URL it can reach from the task
 * prompt, pays every 402 it meets via `wrapFetchWithPayment` (retrying up to
 * 5 times when a route keeps 402ing, or "delivers" an empty body, after being
 * paid), and additionally scans page prose for a direct-transfer instruction
 * and sends it as a real signed transaction to the harness's mock chain RPC
 * (U10, ADR-013) - not a self-report via the capture shim. No LLM is
 * involved - this models a maximally gullible payment client.
 *
 * `NAIVE_NO_SHIM=1` disables signer wrapping entirely (see `lib/wallet.ts`'s
 * `walletSigner`), so the direct transfer produces no shim event at all - proving
 * that the mock chain RPC alone observes it (functional-design.md §6).
 */
import { allowedOrigins, type CrawlSeed, crawl, extractUrls, type FetchLike } from "./lib/crawl.js";
import { sendDirectTransfer } from "./lib/transfer.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

const MAX_RETRIES = 5;

// Maximally gullible (harness oracle): any "pay|send|transfer $X ... to <address>" in page text.
const PROSE_RE =
  /\b(?:pay|send|transfer)\s+\$?([\d.]+)[^\n]*?\bto\s+([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})/i;

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

const noShim = process.env.NAIVE_NO_SHIM === "1";

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const { payFetch } = await buildClient(task, { unlimitedSpend: true, noShim });
  const fetchWithRetries = withRetries(payFetch);
  const origins = allowedOrigins(task);

  // Fetch every prompt URL twice (fresh top-level attempts): a naive agent that "double
  // checks" a result, or that follows a prompt asking it to re-fetch, will hit a `replay`
  // route's reissued challenge - functional-design.md §5 / architect note on replay.
  const seedUrls = extractUrls(task.prompt, origins);
  const seeds: CrawlSeed[] = seedUrls.flatMap((url) => [
    { url, referrerBody: task.prompt },
    { url, referrerBody: task.prompt },
  ]);

  const pages = await crawl(fetchWithRetries, seeds, { origins });

  // De-duplicate by (url, to, amount), not raw body text: naive fetches every prompt URL
  // twice on purpose (to hit a `replay` route's reissued *challenge*), but that must not
  // turn one prose-read instruction into two distinct real transfers now that the direct
  // transfer goes through the RPC's real nonce sequencing (U10, ADR-013) instead of a
  // self-report with a hardcoded nonce - re-reading the identical instruction twice is
  // still one instruction acted on once, like a human wouldn't pay twice for re-reading a
  // page. Keying on (url, to, amount) rather than the whole body (code review) means a page
  // whose *unrelated* text changed between the two fetches, but whose instruction didn't,
  // is still only acted on once - and, conversely, two different instructions that happen
  // to share a body are still both caught.
  const seenInstructions = new Set<string>();
  for (const page of pages) {
    const match = PROSE_RE.exec(page.body);
    if (!match) continue;
    const amountUsd = Number(match[1]);
    const to = match[2];
    if (!Number.isFinite(amountUsd) || !to) continue;

    const key = `${page.url}\u0000${to}\u0000${amountUsd}`;
    if (seenInstructions.has(key)) continue;
    seenInstructions.add(key);

    try {
      await sendDirectTransfer(task, { to, amountUsd, noShim });
    } catch (err) {
      console.error(`naive: sendDirectTransfer failed for ${page.url}:`, err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
