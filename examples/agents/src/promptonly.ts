/**
 * TEST-ONLY PROBE - not a reference agent (never documented in the README, never a
 * leaderboard entry; see `application-design.md §8`, which lists only `naive`,
 * `guarded`, `sdk-default` and `llm` as reference/example agents). Wired into the test
 * suite from `packages/cli/test/helpers/agent-cmd.ts`; it lives here, not under
 * `packages/cli/test/helpers/`, only because `packages/cli` has no direct dependency
 * on `@x402/*`/viem/`@solana/kit` (Bolt 5 Phase B forbids adding new lockfile
 * dependencies except via U12) while `examples/agents` already does.
 *
 * The "promptonly" no-guardrail probe, per U11 functional-design.md §6 (mirroring
 * Architecture Review 1's `promptonly.mts` probe that first surfaced corpus
 * circularity): fetches only the literal `task.prompt` URLs, each exactly once, via a
 * bare `wrapFetchWithPayment` with the SDK's default spend controls disabled entirely
 * (no host allowlist, no network check, no per-route dedup, no prose scanning). It
 * never follows a link discovered inside a fetched page's own body - that's the
 * harness's check that a scenario doesn't only "fail" an agent because it declines to
 * crawl (Review 1 B2).
 *
 * Code review (architect ruling): `buildClient(task, { unlimitedSpend: true })` only
 * disables `spendControls.maxAmountPerPayment` - `x402Client`'s asset allowlist
 * ("default assets only" unless `spendControls.allowedAssets` opts in, verified in
 * node_modules/@x402/core/dist/cjs/client/index.js's `applySpendControls`) stays
 * active, which made `asset-swap` unreachable and vacuously "SDK-defended." A probe
 * that models *no guardrail at all* should disable every built-in protection, not just
 * the dollar cap, so this calls `client.setSpendControls(false)` directly
 * ("any asset, no caps", same file) after building the client. That's a strictly wider
 * permission than `unlimitedSpend` (it doesn't change behaviour on any scenario that
 * only uses default assets), so it can't turn a previously-failing scenario into a
 * pass - it only makes `asset-swap` reachable.
 *
 * v4 (U26-2, m7: reach needs the capability the attack needs): its EVM signer is the SDK's
 * own composition for gas-sponsoring extensions (`toClientEvmSigner` over the mock EVM
 * RPC), so it signs any approval a challenge's extensions ask for; and it answers a sign
 * request served as a 402 body on a prompt URL (a challenge-class request), signing it
 * and POSTing the signature. It still never reads page prose, so a sign request served as
 * a 200 page (prose class) is out of its reach by design.
 */
import { allowedOrigins, extractUrls } from "./lib/crawl.js";
import { answerSignRequests, bodyRecorder } from "./lib/sign-request.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const recorder = bodyRecorder();
  const { client, payFetch } = await buildClient(task, {
    evmSigner: "sdk-extensions",
    observe: recorder.observe,
  });
  client.setSpendControls(false);

  const urls = extractUrls(task.prompt, allowedOrigins(task));
  for (const url of urls) {
    try {
      await payFetch(url);
    } catch (err) {
      console.error(`promptonly: fetch failed for ${url}:`, err);
    }
  }

  const bodies = await recorder.bodies();
  await answerSignRequests(
    task,
    bodies.filter((body) => body.status === 402),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
