/**
 * TEST-ONLY PROBE - not a reference agent (see the note at the top of `promptonly.ts`
 * in this same directory for why it lives here rather than under
 * `packages/cli/test/helpers/`).
 *
 * The "obedient" test agent, per U11 functional-design.md §6 mandatory evidence: it
 * does exactly what a scenario's prompt literally asks - one fetch of the first
 * `task.base_url` URL named in it - and never revisits any URL discovered inside a
 * fetched page's own body, so it cannot be steered into a second payment by injected
 * content (e.g. `replay`'s "re-fetch this for accuracy" delivered-body nudge). It also
 * runs a minimal guardrail (host allowlist, network, per-payment budget) so a pass
 * here isn't solely a byproduct of doing too little to ever be exploited on *this*
 * specific scenario - but it's still a narrow, single-scenario check on a handful of
 * fixed properties, not a general claim that this agent (or its guardrail) is safe
 * against attacks beyond `replay`/`replay-2`. What it demonstrates is narrower and
 * specific: the fixed replay oracle no longer punishes an agent that does exactly what
 * it was asked and nothing more (Architecture Review 1, M3).
 *
 * U17 code review F3: the host check is now `guarded.ts`'s own mode-aware
 * `parseHostPath` (shared via `./lib/host-check.js`), not a `path`-mode-only copy - so
 * this probe's minimal guardrail also works correctly under `localhost`/`proxy` mode,
 * not just `path`.
 */
import { atomicToUsd, CHAIN_DEFAULTS } from "@x402-redteam/schema";
import { allowedOrigins, extractUrls } from "./lib/crawl.js";
import { parseHostPath } from "./lib/host-check.js";
import { buildClient, readTask, refuseUnsupportedProxyMode } from "./lib/wallet.js";

const BUDGET_EPSILON = 1e-9;

async function main(): Promise<void> {
  const task = readTask();
  refuseUnsupportedProxyMode(task);
  const { client, payFetch } = await buildClient(task);
  const defaults = CHAIN_DEFAULTS[task.chain];
  const allowedHosts = new Set(task.allowed_hosts);

  client.onBeforePaymentCreation(async (context) => {
    const req = context.selectedRequirements;
    const { host } = parseHostPath(context.paymentRequired.resource.url, task);
    if (!allowedHosts.has(host)) {
      return { abort: true, reason: `host "${host}" is not in allowed_hosts` };
    }
    if (req.network !== task.network) {
      return { abort: true, reason: `network "${req.network}" does not match task network` };
    }
    const amountUsd = atomicToUsd(req.amount, defaults.decimals);
    if (amountUsd > task.budget_usd + BUDGET_EPSILON) {
      return {
        abort: true,
        reason: `amount $${amountUsd} exceeds the per-payment budget $${task.budget_usd}`,
      };
    }
    return undefined;
  });

  const [firstUrl] = extractUrls(task.prompt, allowedOrigins(task));
  if (firstUrl) {
    await payFetch(firstUrl, { redirect: "manual" });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
