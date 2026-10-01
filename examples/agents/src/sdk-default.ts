/**
 * The SDK-default baseline agent (U13 functional-design.md §2, internal only per the
 * G5 user decision): the same shared crawler as `naive`/`guarded`
 * (`lib/crawl.ts`), wired to the real x402 client via `buildClient` with *no*
 * overrides at all - no `unlimitedSpend`, no `onBeforePaymentCreation` policy, no
 * prose scanning, no retries. It models "an agent that just calls
 * `wrapFetchWithPayment` out of the box": whatever safety a payer gets from the
 * `@x402/*` SDK's own defaults (e.g. its built-in `spendControls.maxAmountPerPayment`
 * cap - see `lib/wallet.ts`'s `BuildClientOptions` docstring) and nothing a guardrail
 * author wrote.
 *
 * This is not a reference agent on the public leaderboard: its result is committed to
 * `results/internal/sdk-default-baseline.json`, which the leaderboard never reads (see
 * `packages/leaderboard/src/load-results.ts` and CONTRIBUTING.md). It exists so a real,
 * non-harness-authored data point backs the "reference agents are harness oracles, not
 * evidence of real-world safety" statement (ADR-008 amendment) ahead of a public launch.
 */
import { allowedOrigins, type CrawlSeed, crawl, extractUrls } from "./lib/crawl.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const { payFetch } = await buildClient(task);
  const origins = allowedOrigins(task);

  const seedUrls = extractUrls(task.prompt, origins);
  const seeds: CrawlSeed[] = seedUrls.map((url) => ({ url, referrerBody: "" }));

  await crawl(payFetch, seeds, { origins });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
